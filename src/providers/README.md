# Providers

Vendor-independent interfaces for the three AI services Pipeflow drives, plus
their adapters.

```text
providers/
├── llm/       language models          (interface + adapters/deepseek, openrouter)
├── stt/       speech-to-text           (interface + adapters/deepgram, openrouter)
└── tts/       text-to-speech           (interface + adapters/kokoro)
```

The orchestrator works against the **interfaces**, never vendor APIs — swap a
provider without touching the conversation layer.

## LLM

```ts
interface LLM {
  stream(request: LLMRequest): AsyncGenerator<LLMEvent>;
  stop(): void;
}
```

`stream()` yields `delta` (text tokens), `tool_call` (with JSON-encoded
arguments), `done`, or `error` events. Transport failures are thrown from the
generator. Adapters: `DeepSeekLLM`, `OpenRouterLLM`, `OpenAILLM` (all
OpenAI-compatible) and `ClaudeLLM` (Anthropic Messages API — its own
streamer: `tool_use` content blocks with `input_json_delta` reassembly,
`tool_result` blocks for tool results, required `max_tokens`).

Both adapters accept an optional `onTiming` callback that fires at
`request-start`, `headers`, and `first-chunk` — enough to split application
delay, network/queue delay, and model TTFT apart when profiling voice latency:

Both adapters also abort a stream that delivers no data for `idleTimeoutMs`
(default 8000ms) — a provider whose connection goes silent after the model has
already produced its output (a tool call never followed by a terminating
frame) fails fast with a clear error instead of hanging for tens of seconds.
Raise it for providers with slow first-token times.

An optional `onUsage` callback receives the provider-reported prompt/completion
token counts (OpenRouter includes usage in the stream's final chunk), so
latency-vs-tokens curves are measurable.

Deltas may carry an optional `reasoning` field when the provider streams
thinking tokens separately from content (OpenRouter `reasoning`, DeepSeek
`reasoning_content`) — `bun scripts/latency-profile.ts` probes whether a
model thinks before it speaks, through the same adapter path.

### Tool-call encodings (`toolMode`)

`LLMRequest.toolMode` — or the equivalent adapter option, which a request's
explicit `toolMode` overrides — selects how tool calls are encoded on the
wire. The semantic contract is identical in every mode: callers pass `tools`
and consume the same `delta` / `tool_call` / `done` events, only the encoding
differs.

- `native` (default) — the provider's tool-calling contract: `tools` in the
  request, `tool_calls` in the stream. Streaming deltas and provider-enforced
  argument schemas, at the price of wire overhead: the provider expands the
  schema into its native tool format, billing measurably more prompt tokens
  (often 5-10x the cost of the modes below).
- `envelope` — no `tools`; `response_format` forces the model to emit a JSON
  envelope (`{ answer?, calls: [{ name, arguments }] }`) that the adapter
  translates back into `tool_call` events. Endpoint-guaranteed JSON and a
  lean prompt (dramatically cheaper per decision), but nothing is actionable
  until the whole envelope arrives — no streaming deltas. Only for endpoints
  that support structured outputs.
- `prompted` — the same envelope requested by an instruction appended to the
  last user message. The universal fallback: works on any chat model, at the
  cost of extraction/repair/retry, higher token use, and tail-latency risk.

In `envelope`/`prompted` modes the adapter injects a system-level tool
contract (tool names, descriptions, and the envelope output rule — without
it the model never sees the tool descriptions, which invites prose or native
tool-call syntax) and embeds each tool's argument schema in the envelope, so
the model sees the same argument contract it would in native mode. Replies
that wrap the JSON in fences or lose the opening brace in transport are
repaired before parsing.

The right mode is a property of the model's endpoints, not the caller.
`ToolModeBenchmark` (from `@moureau/pipeflow/providers/llm`) measures it:

```ts
import { ToolModeBenchmark } from "@moureau/pipeflow/providers/llm";

const bench = new ToolModeBenchmark({ apiKey, model, runs: 10 });
const { fastest, cheapest, report } = await bench.run();
// report.native.time.p50    — decision-latency percentiles (p50/p95/p99)
// report.envelope.cost      — median $ per decision
// report.prompted.correct   — runs whose calls all validated
// report.envelope.effectiveCost — $ per decision that was actually correct
```

The benchmark runs all three modes through the real adapter path and reports
per-mode availability, p50/p95/p99 decision latency, median cost (from
OpenRouter registry pricing), correctness (each emitted call's arguments
validated against the probe schema — a call with garbage args is a failed
decision), and effective `$ / correct decision`. Tail percentiles are only
meaningful at `runs` >= 10 (nearest-rank). `bun scripts/envelope-vs-native.ts`
wraps it as a CLI (benchmarking `FAVORITE_MODELS` — the seven models measured
as usable — by default, overridable with `MODELS=`); `scripts/tool-envelope-probe.ts`
checks a model's envelope validity in one run when onboarding.

## STT

```ts
interface STT {
  start(options?: STTOptions): STTSession;
  cancel(): void;
}
```

`start()` opens a streaming session; audio is fed in with `write()` and
transcripts are reported via `partial`/`final` events. Adapters:
`DeepgramSTT` (streaming, with interim results) and `OpenRouterSTT` (batch).

### Conversational STT (Deepgram Flux)

Flux is Deepgram's conversational model with model-integrated end-of-turn
detection, built for voice agents. It is the `DeepgramSTT` default: `flux-*`
models route to the `/v2/listen` endpoint automatically:

```ts
const stt = new DeepgramSTT({
  apiKey: process.env.DEEPGRAM_API_KEY,
  model: "flux-general-en", // or flux-general-multi (10 languages)
});
```

Notes:

- Flux requires the `/v2/listen` endpoint and `encoding`/`sample_rate`
  (`linear16` / `16000` by default) — the adapter handles both.
- Feed audio in ~80ms chunks for optimal model performance and latency
  (≈2560 bytes at 16 kHz linear16).
- End-of-turn behavior is tunable via `eot_threshold` / `eager_eot_threshold`
  / `eot_timeout_ms`; the adapter currently surfaces transcripts as
  `partial`/`final` — Flux's `EagerEndOfTurn` early-response events are a
  designed-for integration point.
- Don't pass `language` with `flux-general-en`; `flux-general-multi` uses
  `language_hint` for language biasing (not yet exposed by the adapter).

### Batch STT (OpenRouter Whisper)

OpenRouter's `/api/v1/audio/transcriptions` endpoint is batch-only — it
transcribes a complete audio clip and returns the text; there is no streaming
and no interim results. `OpenRouterSTT` adapts the streaming `STTSession`
contract to it: the session buffers the raw audio, wraps each utterance in a
WAV header, and transcribes a clip once `silenceMs` (default 800ms) of silence
has elapsed since the last audio:

```ts
const stt = new OpenRouterSTT({
  apiKey: process.env.OPENROUTER_API_KEY,
  model: "openai/whisper-large-v3-turbo",
});
```

Notes:

- Assumes linear16 PCM (mono, `sampleRate`, default 16 kHz) and wraps it in a
  minimal WAV container before upload.
- Language: auto-detected by the provider when omitted. Pass an ISO-639-1
  code to force one (whisper docs say it improves accuracy and latency); the
  whisper-idiomatic `"auto"` is normalized to "omit" and never sent.
- A turn arrives whole at the `final` event once its clip has been
  transcribed — no `partial` events (batch API). Turn latency is
  `silenceMs` + transcription time.
- `end()` transcribes any trailing buffer; `cancel()` drops buffered audio and
  aborts in-flight requests. Clips are transcribed serially, in order.
- Providers time out after 60s per request, so keep utterances short — which
  silence-based segmentation does by construction.

## TTS

```ts
interface TTS {
  stream(request: TTSRequest): AsyncGenerator<Uint8Array>;
  stop(): void;
}
```

### Hosted TTS (Together AI)

`KokoroTTS` targets any OpenAI-compatible `/v1/audio/speech` endpoint — a
local [kokoro-fastapi](https://github.com/remsky/Kokoro-FastAPI) server by
default, or a hosted service such as [Together AI](https://www.together.ai),
which serves the model as `hexgrad/Kokoro-82M`:

```ts
const tts = new KokoroTTS({
  baseUrl: "https://api.together.ai",
  apiKey: process.env.TOGETHER_API_KEY,
  model: "hexgrad/Kokoro-82M",
  stream: true, // progressive audio; only raw output is streamable
});
```

Notes:

- Together AI defaults to non-streaming — pass `stream: true` for realtime
  playback. Streaming responses are server-sent events carrying base64-encoded
  audio deltas (`conversation.item.audio_output.delta`, terminating in
  `data: [DONE]`); the adapter decodes them into raw audio chunks (pcm_s16le,
  24 kHz for Kokoro). wav/mp3 requests are passed through for non-streaming
  synthesis.
- List available voices via Together AI's `/v1/voices` endpoint; the default
  voice (`af_heart`) is supported.
- For the lowest latency, Together AI also exposes a realtime WebSocket
  endpoint (`/v1/audio/speech/websocket`) — a designed-for adapter, not yet
  shipped.

## Usage

```ts
import { DeepSeekLLM, DeepgramSTT, KokoroTTS } from "@moureau/pipeflow/providers";

const pipeflow = new Pipeflow({
  llm: new DeepSeekLLM({ apiKey: process.env.DEEPSEEK_API_KEY }),
  stt: new DeepgramSTT({ apiKey: process.env.DEEPGRAM_API_KEY }),
  tts: new KokoroTTS({ baseUrl: "http://localhost:8880" }),
});
```

Types are importable from the same subpath
(`@moureau/pipeflow/providers/llm`, `/stt`, `/tts` for the individual
interfaces). See the root [README](../../README.md) for the public API.
