// Capability probe: what tool-call paths does a model support, and do they
// produce VALID envelopes?
//
//   LLM_MODEL=sao10k/l3-lunaris-8b bun scripts/tool-envelope-probe.ts
//
// Reports, for the weather (simple) and delegate (coordination) schemas:
//   - envelope mode  (response_format: json_schema) — availability + validity
//   - prompted mode  (instruction only)             — availability + validity
//
// Use it when onboarding a model: it answers "which toolMode, if any, works"
// in one run. `envelope-vs-native.ts` then answers "which is fastest".

const MODEL = process.env.LLM_MODEL ?? "sao10k/l3-lunaris-8b";
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required");
  process.exit(1);
}
// Narrowed const so hoisted functions below see a string, not string|undefined.
const KEY = apiKey;

const COORDINATOR_PROMPT = `You are the conversation coordinator. The available agents are:
- Travel Agent (aliases: travel)
- Calendar Agent (aliases: calendar)

Decide the best next step and take exactly one: delegate to one or more agents, pass the work to another coordination, ask the user a clarifying question when the request is ambiguous or missing critical information, or answer directly when you have everything you need.`;

const PROMPT =
  "Book me a flight from Paris to London tomorrow morning, and check whether Tuesday afternoon is free.";

const WEATHER_PROMPT =
  "You are a weather assistant. Always use the get_weather tool to answer, calling it once per city. What is the weather in Paris and Tokyo?";

// Schema 1: the weather envelope (all-required, strict-safe).
const weatherSchema = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
  additionalProperties: false,
};

// Schema 2: the delegate envelope (flat shape, optional fields — non-strict).
const delegateSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["agents", "coordination", "clarify", "user", "complete"] },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: { agent: { type: "string" }, prompt: { type: "string" } },
        required: ["agent", "prompt"],
      },
    },
    coordination: { type: "string" },
    question: { type: "string" },
    output: { type: "string" },
  },
  required: ["action"],
};

/** Strip markdown fences and keep the outermost JSON object. */
function extractJson(raw: string): string | null {
  const stripped = raw
    .replace(/```(?:json)?/gi, "")
    .replace(/^[^{]*/, "")
    .replace(/[^}]*$/, "");
  if (stripped.length === 0) return null;
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return stripped.slice(start, end + 1);
}

async function probe(
  label: string,
  messages: unknown[],
  schema: unknown,
  strict: boolean,
  mode: "envelope" | "prompted",
): Promise<void> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
    temperature: 0,
    stream: false,
  };
  if (mode === "envelope") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "tool_envelope", strict, schema },
    };
  } else {
    const last = messages.at(-1) as { content: string };
    messages = [
      ...messages.slice(0, -1),
      {
        ...last,
        content: `${last.content}\n\nRespond with ONLY valid JSON matching this schema, no prose, no markdown fences:\n${JSON.stringify(schema)}`,
      },
    ];
    body.messages = messages;
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    console.log(
      `\n${label} (${mode}): request failed (${response.status}) ${(await response.text()).slice(0, 200)}`,
    );
    return;
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const tokens = data.usage
    ? `${data.usage.prompt_tokens ?? "—"}/${data.usage.completion_tokens ?? "—"}`
    : "—";
  console.log(`\n${label} (${mode}, tokens ${tokens})`);
  console.log(`  raw: ${content.slice(0, 200)}${content.length > 200 ? "…" : ""}`);

  const json = mode === "envelope" ? content : extractJson(content);
  if (json === null) {
    console.log("  parse: FAILED (no JSON found)");
    return;
  }
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (label.includes("weather")) {
      console.log(`  valid weather call: ${typeof parsed.city === "string" && parsed.city.length > 0}`);
    } else {
      const valid = typeof parsed.action === "string";
      console.log(`  valid delegate call: ${valid}${valid ? ` (action: ${parsed.action})` : ""}`);
    }
  } catch {
    console.log("  parse: FAILED (not JSON)");
  }
}

for (const mode of ["envelope", "prompted"] as const) {
  await probe("weather", [
    { role: "system", content: WEATHER_PROMPT },
    { role: "user", content: "What is the weather in Paris and Tokyo?" },
  ], weatherSchema, true, mode);

  await probe("delegate", [
    { role: "system", content: COORDINATOR_PROMPT },
    { role: "user", content: PROMPT },
  ], delegateSchema, false, mode);
}
