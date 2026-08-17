import { describe, expect, test } from "bun:test";
import { DeepSeekLLM } from "../providers/llm/adapters/deepseek/deepseek";
import { OpenRouterLLM } from "../providers/llm/adapters/openrouter/openrouter";
import type {
  LLM,
  LLMStreamTimingPoint,
  LLMUsageCallback,
} from "../providers/llm/types";
import {
  ReferenceDecoder,
  StreamObject,
  materializeObject,
  type Event,
  type FieldValue,
  type Schema,
} from "../transport/streamobject";

// End-to-end experiment against a real LLM, three arms of the same task
// (analyze a quote → {summary, sentiment, topics, confidence}):
//
//   A. protocol-direct  — the model is prompted to emit StreamObject wire
//      records itself. Kept as the negative control: measured empirically to
//      cost ~5-6x completion tokens and lose time-to-first-data, because a
//      language model cannot count character lengths reliably and spends
//      tokens describing transport mechanics.
//
//   B. json-object      — the model emits ordinary JSON; the consumer waits
//      for the full object and JSON.parses it. Time-to-useful-data = the
//      whole stream.
//
//   C. json→adapter     — the SAME model output as B (one LLM call, teed to
//      both consumers): an incremental JSON parser emits field-completion
//      events the moment each field's value is complete, without waiting for
//      the rest of the object. Identical output, identical tokens — only the
//      consumption topology differs.
//
// The metric that matters is TTF-field vs TT-object on arm C: does the
// consumer get usable fields before the whole object exists?
//
// Findings so far: flash-class models cannot reliably emit exact length
// prefixes (43 vs 48, 34 vs 32, 15 vs 5) nor hold completion discipline on
// the first try, so arm A routes scalars through single-char appends and each
// arm allows up to 3 attempts (adherence failures are logged, not hidden).
//
// The final experiment measures the execution primitive: A produces a LONG
// object (short summary first, then a long analysis); B starts on the summary
// field while A is still generating, and B's completion cancels A. Token
// savings and the end-to-end critical path are compared against the
// sequential baseline (A full, then B).
//
// Skipped when no API key is present. Set LLM_MODEL to override the model.

const apiKey = process.env.DEEPSEEK_API_KEY;
const openRouterKey = process.env.OPENROUTER_API_KEY;
const hasKey =
  (typeof apiKey === "string" && apiKey.length > 0) ||
  (typeof openRouterKey === "string" && openRouterKey.length > 0);

function e2e(name: string, fn: () => Promise<void>, timeoutMs = 120_000): void {
  if (hasKey) test(name, fn, timeoutMs);
  else test.skip(name, fn);
}

function makeLlm(
  onTiming?: (point: LLMStreamTimingPoint) => void,
  onUsage?: LLMUsageCallback,
): LLM {
  if (openRouterKey) {
    return new OpenRouterLLM({
      apiKey: openRouterKey,
      model: process.env.LLM_MODEL ?? "google/gemini-2.5-flash-lite",
      onTiming,
      onUsage,
    });
  }
  return new DeepSeekLLM({
    apiKey: apiKey!,
    model: "deepseek-v4-flash",
    onTiming,
    onUsage,
  });
}

/**
 * The object the model must produce. Field ids are positional:
 * 0 = summary, 1 = sentiment, 2 = topics (array), 3 = confidence.
 */
const SCHEMA: Schema = [
  { path: ["summary"], type: "string", maxLength: 600 },
  { path: ["sentiment"], type: "string", maxLength: 16 },
  { path: ["topics"], type: "string", mode: "array", maxItems: 6, maxLength: 48 },
  { path: ["confidence"], type: "integer", maxLength: 3 },
];

const QUOTE = "The quick brown fox jumps over the lazy dog.";

const PROTOCOL_PROMPT = `You are an analysis engine that emits its structured output as a stream of
records in the "StreamObject" wire format. Emit NOTHING except those records.
The wire is one dense string: no prose, no markdown, no whitespace between
records.

Schema (field id - meaning):
  0 - summary: string
  1 - sentiment: string, one of "positive", "negative", "neutral"
  2 - topics: array of strings
  3 - confidence: integer between 0 and 100

Grammar - every record ends with ';':
  append payload:   <field>:<length>:<payload>;
  complete a field: !<field>;
  finish the object: !;

Rules:
- Fields 0 and 1 are scalars: append their characters ONE AT A TIME as
  <field>:1:<char>;. Spaces inside the value are payload characters too
  (0:1: ;). Append characters until the value is complete.
- Complete a field ONLY after you have appended EVERY character of its value.
  Completing early truncates the value and is a serious error.
- The sentiment must be the complete word "positive", "negative", or
  "neutral" - never an abbreviation or a single letter.
- Field 2 is an array: append ALL topics first, each topic as ONE record
  containing the whole word (<field>:<length>:<word>;). They accumulate into
  the same field. Do NOT complete field 2 until every topic has been appended.
- Field 3 is an integer: ONE record containing the digits
  (<field>:<length>:<digits>;).
- Complete each field exactly once with !<field>;. Finish with !;.
- <length> is the exact number of characters in <payload> (ASCII only).

Example for a similar task (summary "hi there", sentiment "ok", topics
"fun" and "code", confidence 42):
  0:1:h;0:1:i;0:1: ;0:1:t;0:1:h;0:1:e;0:1:r;0:1:e;!0;1:1:o;1:1:k;!1;2:3:fun;2:4:code;!2;3:2:42;!3;!;

Task: analyze the quote "${QUOTE}"
Produce a 1-2 sentence summary, the sentiment, 2-4 topics, and a confidence
percentage. Stream the records as you generate them.`;

const JSON_PROMPT = `You are an analysis engine. Return ONLY a JSON object with exactly these keys
(no prose, no markdown, no trailing text):

{
  "summary": "1-2 sentence summary of the quote, under 150 characters",
  "sentiment": "positive" | "negative" | "neutral",
  "topics": ["2-4 short topic strings"],
  "confidence": 0-100 integer
}

Task: analyze the quote "${QUOTE}"`;

type TimingCapture = Record<LLMStreamTimingPoint, number>;
type UsageCapture = { promptTokens: number; completionTokens: number };

interface FieldTiming {
  field: number;
  path: string[];
  atMs: number; // ms from start when the field completed
  chars: number; // chars consumed at completion
  value: FieldValue;
}

/** Arm A: the model emits StreamObject wire records directly. */
interface ProtocolResult {
  object: Record<string, unknown>;
  events: Event[];
  firstFieldAt: number;
  firstFieldId: number | undefined;
  completeAt: number; // ms from start, at `!;`
  ttft: number;
  chars: number;
  completionTokens: number;
  fieldTimings: FieldTiming[];
  raw: string;
}

/** Arms B+C: one JSON-prompt call teed to both the adapter and JSON.parse. */
interface JsonArmResult {
  object: Record<string, unknown>; // from JSON.parse (arm B, full object)
  adapterObject: Record<string, unknown>; // from adapter events (arm C)
  objectAt: number; // ms from start when the full object was usable
  ttft: number;
  chars: number;
  completionTokens: number;
  fieldTimings: FieldTiming[]; // arm C per-key completion
  firstFieldAt: number; // arm C
  raw: string;
}

async function runProtocolAttempt(): Promise<ProtocolResult> {
  const timing: TimingCapture = { "request-start": 0, headers: 0, "first-chunk": 0 };
  const usage: UsageCapture = { promptTokens: 0, completionTokens: 0 };
  const llm = makeLlm(
    (point) => {
      timing[point] = performance.now();
    },
    (u) => {
      usage.promptTokens = u.promptTokens;
      usage.completionTokens = u.completionTokens;
    },
  );

  const startedAt = performance.now();
  const fieldAt: Record<number, number> = {};
  const fieldChars: Record<number, number> = {};
  const fieldValues: Record<number, FieldValue> = {};
  let firstFieldAt = 0;
  let firstFieldId: number | undefined;
  let objectEndedAt = 0;
  let ended = false;
  let charsPushed = 0;
  let raw = "";

  const decoder = new ReferenceDecoder(SCHEMA, (event) => {
    if (event.kind === "field") {
      const atMs = performance.now() - startedAt;
      fieldAt[event.field] = atMs;
      fieldChars[event.field] = charsPushed;
      fieldValues[event.field] = event.value;
      if (firstFieldAt === 0) {
        firstFieldAt = atMs;
        firstFieldId = event.field;
      }
    }
    if (event.kind === "object-complete" || event.kind === "object-abort") {
      objectEndedAt = performance.now();
      ended = true;
    }
  });

  // Push character by character (fragmentation is semantically invisible) and
  // stop pushing at `!;` — but keep draining the stream so the provider's
  // usage chunk (which arrives after finish_reason) is captured.
  for await (const event of llm.stream({
    messages: [
      { role: "system", content: PROTOCOL_PROMPT },
      { role: "user", content: "Analyze the quote." },
    ],
    temperature: 0,
    maxTokens: 1000,
  })) {
    if (event.type === "error") throw event.error;
    if (event.type !== "delta") continue;
    raw += event.content;
    if (ended) continue;
    for (let i = 0; i < event.content.length; i++) {
      if (ended) break;
      charsPushed++;
      decoder.push(event.content[i]!);
    }
  }

  if (!ended) {
    throw new Error(
      `the model never emitted the terminating !; record\nraw output (tail):\n${raw.slice(-300)}`,
    );
  }
  const events = decoder.end();
  if (events.some((e) => e.kind === "object-abort")) {
    throw new Error("the model aborted the object");
  }
  const object = materializeObject(SCHEMA, events);
  validateShape(object);

  return {
    object,
    events,
    firstFieldAt,
    firstFieldId,
    completeAt: objectEndedAt - startedAt,
    ttft: Math.max(0, timing["first-chunk"] - timing["request-start"]),
    chars: charsPushed,
    completionTokens: usage.completionTokens,
    fieldTimings: SCHEMA.map((def, field) => ({
      field,
      path: def.path,
      atMs: fieldAt[field] ?? -1,
      chars: fieldChars[field] ?? -1,
      value: fieldValues[field]!,
    })),
    raw,
  };
}

/** Arms B+C: one JSON generation, two consumers (incremental + whole-object). */
async function runJsonArm(): Promise<JsonArmResult> {
  const timing: TimingCapture = { "request-start": 0, headers: 0, "first-chunk": 0 };
  const usage: UsageCapture = { promptTokens: 0, completionTokens: 0 };
  const llm = makeLlm(
    (point) => {
      timing[point] = performance.now();
    },
    (u) => {
      usage.promptTokens = u.promptTokens;
      usage.completionTokens = u.completionTokens;
    },
  );

  const startedAt = performance.now();
  const fieldAt: Record<number, number> = {};
  const fieldChars: Record<number, number> = {};
  const fieldValues: Record<number, FieldValue> = {};
  let chars = 0;
  let raw = "";
  let adapterObject: Record<string, unknown> | undefined;
  let streamError: Error | undefined;

  // One generation, teed to two consumers: the raw accumulator (arm B,
  // JSON.parse at the end) and the StreamObject semantic API (arm C, field
  // completion events as they happen).
  const source = (async function* () {
    for await (const event of llm.stream({
      messages: [
        { role: "system", content: JSON_PROMPT },
        { role: "user", content: "Analyze the quote." },
      ],
      temperature: 0,
      maxTokens: 1000,
    })) {
      if (event.type === "error") throw event.error;
      if (event.type !== "delta") continue;
      raw += event.content;
      chars += event.content.length;
      yield event.content;
    }
  })();

  const stream = new StreamObject(source, SCHEMA);
  stream.onError((error) => {
    streamError = error;
  });
  SCHEMA.forEach((def, field) => {
    const key = def.path.join(".");
    stream.when(key, (value) => {
      fieldAt[field] = performance.now() - startedAt;
      fieldChars[field] = chars;
      fieldValues[field] = value;
    });
  });
  stream.whenObjectDone((object) => {
    adapterObject = object;
  });

  await stream.start();
  if (streamError !== undefined) throw streamError;
  if (adapterObject === undefined) {
    throw new Error(
      `the adapter never saw the complete object\nraw output (tail):\n${raw.slice(-300)}`,
    );
  }

  const object = extractJson(raw);
  validateShape(object);

  // The incremental view must agree with the full parse, field by field
  // (key order can differ, so compare per schema path).
  for (const def of SCHEMA) {
    const key = def.path.join(".");
    if (JSON.stringify(adapterObject[key]) !== JSON.stringify(object[key])) {
      throw new Error(
        `adapter materialization diverged from JSON.parse at ${key}:\n` +
          `adapter: ${JSON.stringify(adapterObject[key])}\n` +
          `parse:   ${JSON.stringify(object[key])}`,
      );
    }
  }

  const objectAt = performance.now() - startedAt;
  const firstFieldAt = Math.min(...SCHEMA.map((_, f) => fieldAt[f] ?? Infinity));

  return {
    object,
    adapterObject,
    objectAt,
    ttft: Math.max(0, timing["first-chunk"] - timing["request-start"]),
    chars,
    completionTokens: usage.completionTokens,
    fieldTimings: SCHEMA.map((def, field) => ({
      field,
      path: def.path,
      atMs: fieldAt[field] ?? -1,
      chars: fieldChars[field] ?? -1,
      value: fieldValues[field]!,
    })),
    firstFieldAt,
    raw,
  };
}

/** Retry a generation attempt; adherence failures are logged, not hidden. */
async function withRetries<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ value: T; attempts: number }> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return { value: await fn(), attempts: attempt };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`attempt ${attempt}: ${detail}`);
      console.info(
        `[streamobject e2e] ${label} attempt ${attempt} failed: ${detail.split("\n")[0]}`,
      );
    }
  }
  throw new Error(`${label} failed after 3 attempts:\n\n${failures.join("\n\n")}`);
}

function extractJson(raw: string): Record<string, unknown> {
  const stripped = raw.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`no JSON object in output\nraw output (tail):\n${raw.slice(-300)}`);
  }
  const text = stripped.slice(start, end + 1);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `JSON.parse failed: ${error instanceof Error ? error.message : String(error)}\nraw output (tail):\n${raw.slice(-300)}`,
    );
  }
}

/** Structural validation — throws (and thus retries) on malformed content. */
function validateShape(object: Record<string, unknown>): void {
  const summary = object.summary;
  const sentiment = object.sentiment;
  const topics = object.topics;
  const confidence = object.confidence;
  if (typeof summary !== "string" || summary.length < 1) {
    throw new Error(`invalid summary: ${JSON.stringify(summary)}`);
  }
  if (typeof sentiment !== "string" || !["positive", "negative", "neutral"].includes(sentiment)) {
    throw new Error(`invalid sentiment: ${JSON.stringify(sentiment)}`);
  }
  if (
    !Array.isArray(topics) ||
    topics.length < 1 ||
    topics.some((t) => typeof t !== "string" || (t as string).length < 1)
  ) {
    throw new Error(`invalid topics: ${JSON.stringify(topics)}`);
  }
  if (
    typeof confidence !== "number" ||
    !Number.isInteger(confidence) ||
    confidence < 0 ||
    confidence > 100
  ) {
    throw new Error(`invalid confidence: ${JSON.stringify(confidence)}`);
  }
}

// ---------------------------------------------------------------------------
// Dependency experiment: LLM B starts on A's summary field, while A is still
// generating, versus the whole-object baseline. One A call; B runs twice —
// once triggered by the summary field completion, once after the object is
// fully available — so the comparison is measured on identical A output.
// ---------------------------------------------------------------------------

interface BTiming {
  startAt: number;
  firstTokenAt: number;
  completeAt: number;
  promptTokens: number;
  completionTokens: number;
}

interface DependencyResult {
  summaryAt: number; // A: summary field completed
  aObjectAt: number; // A: full object usable (JSON.parse)
  aCompletionTokens: number;
  ttft: number;
  bTimings: Partial<Record<"early" | "late", BTiming>>;
}

async function runDependencyExperiment(): Promise<DependencyResult> {
  const timing: TimingCapture = { "request-start": 0, headers: 0, "first-chunk": 0 };
  const usageA: UsageCapture = { promptTokens: 0, completionTokens: 0 };
  const llmA = makeLlm(
    (point) => {
      timing[point] = performance.now();
    },
    (u) => {
      usageA.promptTokens = u.promptTokens;
      usageA.completionTokens = u.completionTokens;
    },
  );

  const aStart = performance.now();
  let summary: string | undefined;
  let summaryAt = 0;
  let aObjectAt = 0;
  const bTimings: Partial<Record<"early" | "late", BTiming>> = {};
  const bPromises: Promise<void>[] = [];
  let streamError: Error | undefined;

  function runB(label: "early" | "late", summaryText: string): void {
    const usageB: UsageCapture = { promptTokens: 0, completionTokens: 0 };
    const llmB = makeLlm(undefined, (u) => {
      usageB.promptTokens = u.promptTokens;
      usageB.completionTokens = u.completionTokens;
    });
    const startAt = performance.now() - aStart;
    let firstTokenAt = 0;
    bPromises.push(
      (async () => {
        for await (const event of llmB.stream({
          messages: [
            {
              role: "system",
              content:
                `You are a router. The summary of a text is: "${summaryText}". ` +
                `Reply with exactly one word: enough.`,
            },
            { role: "user", content: "Route." },
          ],
          temperature: 0,
          maxTokens: 10,
        })) {
          if (event.type === "error") throw event.error;
          if (event.type === "delta" && firstTokenAt === 0) {
            firstTokenAt = performance.now() - aStart;
          }
        }
        bTimings[label] = {
          startAt,
          firstTokenAt,
          completeAt: performance.now() - aStart,
          promptTokens: usageB.promptTokens,
          completionTokens: usageB.completionTokens,
        };
      })(),
    );
  }

  const stream = new StreamObject(
    (async function* () {
      for await (const event of llmA.stream({
        messages: [
          { role: "system", content: JSON_PROMPT },
          { role: "user", content: "Analyze the quote." },
        ],
        temperature: 0,
        maxTokens: 1000,
      })) {
        if (event.type === "error") throw event.error;
        if (event.type !== "delta") continue;
        yield event.content;
      }
    })(),
    SCHEMA,
  );
  stream.onError((error) => {
    streamError = error;
  });
  stream.when("summary", (value) => {
    summary = value as string;
    summaryAt = performance.now() - aStart;
    runB("early", summary); // B starts here, while A is still generating
  });
  stream.whenObjectDone((object) => {
    validateShape(object);
    aObjectAt = performance.now() - aStart;
    if (summary !== undefined) runB("late", summary); // the classic path
  });

  await stream.start();
  if (streamError !== undefined) throw streamError;
  if (summary === undefined) throw new Error("A never completed the summary field");
  if (aObjectAt === 0) throw new Error("A never completed the object");

  await Promise.all(bPromises);
  return {
    summaryAt,
    aObjectAt,
    aCompletionTokens: usageA.completionTokens,
    ttft: Math.max(0, timing["first-chunk"] - timing["request-start"]),
    bTimings,
  };
}

// ---------------------------------------------------------------------------
// Cancellation + critical-path experiment: A produces a LONG object (short
// summary first, then a long analysis). B runs on the summary alone; when B
// completes, A is cancelled. Compared against the sequential baseline (A
// full, then B). Same prompts, temperature 0, so A's output is essentially
// the same length in both arms.
// ---------------------------------------------------------------------------

const LONG_SCHEMA: Schema = [
  { path: ["summary"], type: "string", maxLength: 200 },
  { path: ["analysis"], type: "string", maxLength: 2048 },
  { path: ["topics"], type: "string", mode: "array", maxItems: 8, maxLength: 48 },
  { path: ["confidence"], type: "integer", maxLength: 3 },
];

const LONG_JSON_PROMPT = `You are an analysis engine. Return ONLY a JSON object with exactly these keys
(no prose, no markdown, no trailing text):

{
  "summary": "one short sentence summarizing the quote (under 60 characters)",
  "analysis": "a detailed paragraph of AT LEAST 10 sentences analyzing the quote: its linguistic structure, rhythm, and cultural significance",
  "topics": ["4 short topic strings"],
  "confidence": 0-100 integer
}

Task: analyze the quote "${QUOTE}"`;

function bPrompt(summary: string): string {
  return `The summary of a text is: "${summary}". Write exactly 2 sentences expanding on it.`;
}

function validateLongShape(object: Record<string, unknown>): void {
  const summary = object.summary;
  const analysis = object.analysis;
  const topics = object.topics;
  const confidence = object.confidence;
  if (typeof summary !== "string" || summary.length < 10) {
    throw new Error(`invalid summary: ${JSON.stringify(summary)}`);
  }
  if (typeof analysis !== "string" || analysis.length < 300) {
    throw new Error(
      `analysis too short (${typeof analysis === "string" ? analysis.length : "?"} chars, need >= 300)`,
    );
  }
  if (
    !Array.isArray(topics) ||
    topics.length < 1 ||
    topics.some((t) => typeof t !== "string")
  ) {
    throw new Error(`invalid topics: ${JSON.stringify(topics)}`);
  }
  if (
    typeof confidence !== "number" ||
    !Number.isInteger(confidence) ||
    confidence < 0 ||
    confidence > 100
  ) {
    throw new Error(`invalid confidence: ${JSON.stringify(confidence)}`);
  }
}

interface SeqArmResult {
  aFullChars: number;
  aFullTokens: number;
  aDone: number; // ms from arm start: A's full object ready
  bStart: number;
  bFirstToken: number;
  bDone: number;
  total: number; // end-to-end = bDone
}

async function runSequentialArm(): Promise<SeqArmResult> {
  const aStart = performance.now();
  const usageA: UsageCapture = { promptTokens: 0, completionTokens: 0 };
  const llmA = makeLlm(undefined, (u) => {
    usageA.promptTokens = u.promptTokens;
    usageA.completionTokens = u.completionTokens;
  });

  let aRaw = "";
  for await (const event of llmA.stream({
    messages: [
      { role: "system", content: LONG_JSON_PROMPT },
      { role: "user", content: "Analyze the quote." },
    ],
    temperature: 0,
    maxTokens: 2000,
  })) {
    if (event.type === "error") throw event.error;
    if (event.type !== "delta") continue;
    aRaw += event.content;
  }
  const object = extractJson(aRaw);
  validateLongShape(object);
  const aDone = performance.now() - aStart;
  const summary = object.summary as string;

  // B after A's full object — the classic path.
  const llmB = makeLlm();
  const bStart = performance.now() - aStart;
  let bFirstToken = 0;
  for await (const event of llmB.stream({
    messages: [
      { role: "system", content: bPrompt(summary) },
      { role: "user", content: "Go." },
    ],
    temperature: 0,
    maxTokens: 200,
  })) {
    if (event.type === "error") throw event.error;
    if (event.type === "delta" && bFirstToken === 0) bFirstToken = performance.now() - aStart;
  }
  const bDone = performance.now() - aStart;

  return {
    aFullChars: aRaw.length,
    aFullTokens: usageA.completionTokens,
    aDone,
    bStart,
    bFirstToken,
    bDone,
    total: bDone,
  };
}

interface StreamArmResult {
  aCharsConsumed: number;
  aSummaryDone: number;
  bStart: number;
  bFirstToken: number;
  bDone: number;
  total: number; // end-to-end = bDone
}

async function runStreamingArm(): Promise<StreamArmResult> {
  const aStart = performance.now();
  const llmA = makeLlm();

  let summary: string | undefined;
  let aSummaryDone = 0;
  let aCharsConsumed = 0;
  let bPromise: Promise<void> | undefined;
  let bStart = 0;
  let bFirstToken = 0;
  let bDone = 0;
  let streamError: Error | undefined;

  // Count A's output at the transport boundary (the semantic API below never
  // sees chunks).
  const source = (async function* () {
    for await (const event of llmA.stream({
      messages: [
        { role: "system", content: LONG_JSON_PROMPT },
        { role: "user", content: "Analyze the quote." },
      ],
      temperature: 0,
      maxTokens: 2000,
    })) {
      if (event.type === "error") throw event.error;
      if (event.type !== "delta") continue;
      aCharsConsumed += event.content.length;
      yield event.content;
    }
  })();

  const stream = new StreamObject(source, LONG_SCHEMA, {
    onCancel: () => llmA.stop(), // cancel() aborts the producer
  });
  stream.onError((error) => {
    streamError = error;
  });

  stream.when("summary", (value) => {
    summary = value as string;
    aSummaryDone = performance.now() - aStart;
    bStart = aSummaryDone;
    bPromise = (async () => {
      const llmB = makeLlm();
      try {
        for await (const event of llmB.stream({
          messages: [
            { role: "system", content: bPrompt(summary!) },
            { role: "user", content: "Go." },
          ],
          temperature: 0,
          maxTokens: 200,
        })) {
          if (event.type === "error") throw event.error;
          if (event.type === "delta" && bFirstToken === 0) {
            bFirstToken = performance.now() - aStart;
          }
        }
      } finally {
        bDone = performance.now() - aStart;
        stream.cancel(); // B has what it needs — cancel A's remaining generation
      }
    })();
  });

  await stream.start();
  if (streamError !== undefined) throw streamError;
  if (summary === undefined) throw new Error("A never completed the summary field");
  if (bPromise !== undefined) await bPromise;
  if (bDone === 0) throw new Error("B never completed");

  return { aCharsConsumed, aSummaryDone, bStart, bFirstToken, bDone, total: bDone };
}

describe("StreamObject e2e (requires DEEPSEEK_API_KEY or OPENROUTER_API_KEY)", () => {
  e2e("three arms: protocol-direct vs json-object vs json→adapter", async () => {
    const protocol = await withRetries("protocol-direct", runProtocolAttempt);
    const json = await withRetries("json → adapter", runJsonArm);
    const p = protocol.value;
    const j = json.value;

    // Arm C is the controlled comparison: identical output and tokens to arm
    // B, only the consumption topology differs. Every field must complete
    // before the whole object exists.
    expect(j.fieldTimings.map((t) => t.field).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    for (const t of j.fieldTimings) {
      expect(t.atMs).toBeGreaterThan(0);
      expect(t.atMs).toBeLessThan(j.objectAt);
    }
    expect(j.firstFieldAt).toBeLessThan(j.objectAt);

    // The incremental adapter view agrees with the full JSON parse.
    expect(j.adapterObject).toEqual(j.object);
    expect(typeof j.object.summary).toBe("string");
    expect(["positive", "negative", "neutral"]).toContain(j.object.sentiment as string);

    // Arm A kept as the negative control: direct emission is verbose.
    expect(p.firstFieldAt).toBeGreaterThan(0);
    expect(p.firstFieldAt).toBeLessThan(p.completeAt);
    expect(p.chars).toBeGreaterThan(j.chars);
    if (p.completionTokens > 0 && j.completionTokens > 0) {
      // Generous bound: observed ratio is ~5-6x; 8x guards run-to-run variance.
      expect(p.completionTokens).toBeLessThan(j.completionTokens * 8);
    }

    const pad = (n: number, w: number): string => String(n.toFixed(0)).padStart(w);
    console.info(
      [
        "",
        "[streamobject e2e] comparison — same task, same model, temperature 0:",
        "  metric                   protocol-direct   json object   json→adapter",
        `  ttft (ms)                 ${pad(p.ttft, 8)}${pad(j.ttft, 16)}${pad(j.ttft, 15)}`,
        `  first field (ms)          ${pad(p.firstFieldAt, 8)}${"n/a".padStart(16)}${pad(j.firstFieldAt, 15)}`,
        `  object complete (ms)      ${pad(p.completeAt, 8)}${pad(j.objectAt, 16)}${pad(j.objectAt, 15)}`,
        `  wire chars                ${String(p.chars).padStart(8)}${String(j.chars).padStart(16)}${String(j.chars).padStart(15)}`,
        `  completion tokens         ${String(p.completionTokens).padStart(8)}${String(j.completionTokens).padStart(16)}${String(j.completionTokens).padStart(15)}`,
        `  attempts                  ${String(protocol.attempts).padStart(8)}${String(json.attempts).padStart(16)}${String(json.attempts).padStart(15)}`,
      ].join("\n"),
    );

    // The measured invention: per-key delivery on ordinary JSON output, with
    // the model still generating the remaining fields.
    const keyRows = j.fieldTimings.map((t) => {
      const value = JSON.stringify(t.value);
      const delta = t.atMs - j.objectAt; // negative = before the whole object
      return (
        `  ${t.path.join(".").padEnd(11)}${String(t.atMs.toFixed(0)).padStart(6)}ms  ` +
        `${String(t.chars).padStart(4)} chars  ${delta < 0 ? "-" : "+"}${Math.abs(delta).toFixed(0)}ms vs object  ` +
        `${value.slice(0, 44)}${value.length > 44 ? "…" : ""}`
      );
    });
    console.info(
      [
        "",
        `[streamobject e2e] json→adapter per-key completion — full object usable at ${j.objectAt.toFixed(0)}ms:`,
        ...keyRows,
        "",
      ].join("\n"),
    );
    console.info(`[streamobject e2e] protocol materialized: ${JSON.stringify(p.object)}`);
    console.info(`[streamobject e2e] json object:           ${JSON.stringify(j.object)}`);
  });

  e2e("downstream LLM starts on A's summary field, while A is still generating", async () => {
    const experiment = await withRetries("dependency", runDependencyExperiment);
    const e = experiment.value;
    const early = e.bTimings.early;
    const late = e.bTimings.late;

    expect(early).toBeDefined();
    expect(late).toBeDefined();
    expect(e.summaryAt).toBeLessThan(e.aObjectAt);
    // The headline: B began before A's object existed.
    expect(early!.startAt).toBeLessThan(e.aObjectAt);
    expect(early!.startAt).toBeLessThan(late!.startAt);

    const delta = late!.startAt - early!.startAt;
    console.info(
      [
        "",
        "[streamobject e2e] dependency metrics — B routes on A's summary:",
        `  TTF(summary) = ${e.summaryAt.toFixed(0)}ms | TTF(object) = ${e.aObjectAt.toFixed(0)}ms |` +
          ` overlap = ${(e.aObjectAt - e.summaryAt).toFixed(0)}ms | A tokens ${e.aCompletionTokens}`,
        `  downstream_work_started_before_object = ${early!.startAt < e.aObjectAt}` +
          ` (B early start ${early!.startAt.toFixed(0)}ms < object ${e.aObjectAt.toFixed(0)}ms)`,
        `  B early: start ${early!.startAt.toFixed(0)}ms | first token ${early!.firstTokenAt.toFixed(0)}ms |` +
          ` done ${early!.completeAt.toFixed(0)}ms | in ${early!.promptTokens} out ${early!.completionTokens}`,
        `  B late:  start ${late!.startAt.toFixed(0)}ms | first token ${late!.firstTokenAt.toFixed(0)}ms |` +
          ` done ${late!.completeAt.toFixed(0)}ms | in ${late!.promptTokens} out ${late!.completionTokens}`,
        `  (B started ${delta.toFixed(0)}ms earlier on identical A output)`,
      ].join("\n"),
    );
  });

  e2e("cancelling A at the summary boundary saves tokens and shrinks the critical path", async () => {
    const seq = await withRetries("sequential", runSequentialArm);
    const stream = await withRetries("streaming+cancel", runStreamingArm);
    const s = seq.value;
    const t = stream.value;

    // Same prompt, temperature 0: A's full output is the baseline. The
    // streaming arm consumed less of it — the cancellation cut A short.
    expect(t.aCharsConsumed).toBeLessThan(s.aFullChars);
    // B ran while A was still generating.
    expect(t.bStart).toBeLessThan(t.bDone);
    // End-to-end critical path: streaming (B done) beats sequential (A full
    // then B) because B overlapped A's long analysis.
    expect(t.bDone).toBeLessThan(s.total);

    const savedChars = s.aFullChars - t.aCharsConsumed;
    const savedPct = ((100 * savedChars) / s.aFullChars).toFixed(0);
    console.info(
      [
        "",
        "[streamobject e2e] cancellation metrics — B runs on A's summary, then cancels A:",
        `  TTF(summary) = ${t.bStart.toFixed(0)}ms | TTF(object, full run) = ${s.aDone.toFixed(0)}ms`,
        `  producer_output_saved = ${savedChars} chars (~${savedPct}%) |` +
          ` producer_tokens_saved ~${Math.round(s.aFullTokens * (savedChars / s.aFullChars))} of ${s.aFullTokens}`,
        `  B: start ${t.bStart.toFixed(0)}ms | first token ${t.bFirstToken.toFixed(0)}ms |` +
          ` done ${t.bDone.toFixed(0)}ms | downstream_work_started_before_object = true`,
        `  critical_path = ${t.total.toFixed(0)}ms (streaming) vs ${s.total.toFixed(0)}ms (sequential)` +
          ` = ${(100 * (t.total / s.total)).toFixed(0)}%`,
      ].join("\n"),
    );
  });
});
