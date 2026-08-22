# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Whisper hallucination filter** — `OpenRouterSTT` cleans transcripts by
  default before emission: asterisk stage directions (`*Dramatic music*`) are
  dropped, consecutive repeated sentences (`Thank you. Thank you.`) collapse
  to one, and transcripts that are entirely a conversational filler
  (`Thank you.`, `Bye.`, …) are suppressed. `filterHallucinations: false`
  returns raw transcripts. These artifacts come from near-silence clips and
  speaker echo, so the example also trims trailing silence and enables
  `echoCancellation`/`noiseSuppression` at the mic.
- **STT sampling/passthrough options** — `OpenRouterSTT` accepts `temperature`
  and `providerOptions` (serialized as the multipart `provider` field).
  OpenRouter ignores whisper's top-level `prompt`, so per-provider options
  (`providerOptions: { options: { groq: { prompt: "…" } } }`) are the only
  route to whisper's prompt.
- **STT language pinning** — `OpenRouterSTT` accepts `language` (ISO-639-1):
  whisper's auto-detection drifts to unrelated scripts on short or quiet
  clips (Portuguese speech transcribed as Japanese/Korean), so forcing the
  code (`language: "pt"`) keeps transcripts on the spoken language and
  reduces hallucinations; the whisper-idiomatic `"auto"` is normalized to
  "omit" (provider-side detection). The WebSocket example passes
  `STT_LANGUAGE` through, leaving detection to the provider when unset.
- **OpenRouter TTS output format option** — `OpenRouterTTS` accepts
  `format: "pcm" | "mp3"` for requests that don't specify one. `pcm`'s sample
  rate is provider-defined and opaque, so mp3 (self-describing) is the choice
  when the client decodes.
- **WebSocket voice-chat example** — `example/` runs a full voice loop in one
  Bun process (whisper → llama-4-scout → fish s2.1 free) over a WebSocket,
  with client-side VAD and per-sentence, pipelined TTS delivered as decodable
  mp3 frames.
- **Conversation tools auto-execute** — agents' tools now run automatically in
  a conversation, exactly like `Agent.run()`: the orchestrator executes the
  matching tool and feeds the result (or a caught error) back into the model
  loop, so no `tool-call` handler is needed. The `tool-call` and
  `tool-call-result` events still fire for visibility. Opt out with
  `autoExecuteTools: false` (on `Pipeflow`, `conversations.create()`, or
  `Conversation`) to keep the application-managed contract — listen for
  `tool-call` and resolve each call yourself with `resolveToolCall()`, e.g.
  for approval flows or tools that run in a different backend. Unknown tool
  names and thrown tool errors surface to the model as `{ "error": ... }` so
  it can recover, and a hung tool is bounded by `toolTimeoutMs`.

### Fixed

- **Example tool handler removed** — the WebSocket example no longer
  hand-wires `tool-call` → `resolveToolCall` (with an unsafe `execute` cast);
  the agent's `get_weather` tool auto-executes.

- **Barge-in cuts the agent's audio on the client** — the example previously
  kept playing already-synthesized sentences after an interrupt (the server
  aborts generation, but queued mp3 frames were still in the client's
  playback queue). The server now forwards the conversation's `interrupt`
  event and the client cuts the current buffer and drops the queue the moment
  the mic hears the user, on a new turn, or on the server message.
- **Example voice drift** — fish's free TTS variant varies the voice per
  request when `voice` is omitted; the example now pins `voice: "alloy"`.
- **Example playback speed** — raw pcm has a provider-defined sample rate
  (fish ≈44.1 kHz), so playing it at a guessed 16 kHz ran ≈2.7× slow; the
  example now requests mp3 and the client decodes each frame at its real
  rate.

## [0.0.2] - 2026-08-22

### Added

- **OpenRouter LLM adapter** — `OpenRouterLLM` routes through any model on the OpenRouter marketplace over a shared OpenAI-compatible streaming engine (now also backing DeepSeek), with app attribution headers (`X-Title: pipeflow`, `HTTP-Referer` defaulting to `https://moureau.dev`).
- **OpenAI and Claude LLM adapters** — `OpenAILLM` rides the same OpenAI-compatible engine (default model `gpt-4o-mini`); `ClaudeLLM` implements the Anthropic Messages API directly (`tool_use` content blocks with `input_json_delta` fragment reassembly, `tool_result` blocks for tool results, required `max_tokens`, usage from `message_start`/`message_delta`). Both exported from `@moureau/pipeflow/providers/llm`.
- **Provider timeline hook** — both LLM adapters accept an `onTiming` callback (`request-start` / `headers` / `first-chunk`) so application delay, network/queue delay, and model TTFT can be separated (`bun scripts/latency-profile.ts` now reports the decomposition).
- **Structured clarification** — the `delegate` tool gains a `clarify` action: the coordination declares the missing details in a `missing` array, and the framework renders and speaks one batched question for all of them (instead of one question per missing detail, model-permitting).
- **History windowing** — the orchestrator bounds the conversation history each LLM request carries (`historyWindow`, default `{ maxTurns: 5, maxChars: 4000 }`), since provider TTFT grows with input size. Measured on nova: an 8KB history cost ~850ms of pre-first-byte latency; windowing it back to ~5 turns restored the ~430ms regime.
- **Provider token usage** — both LLM adapters accept an `onUsage` callback receiving the provider-reported prompt/completion tokens (`bun scripts/latency-profile.ts` now reports tokens per scenario, with a local estimate to expose schema/system-prompt overhead).
- **Deterministic question budget** — `clarify` and `user` question rounds are capped per coordination run at `maxQuestionRounds` (default 2, carried across suspensions); past the cap the coordination states reasonable assumptions and completes. The real-model clarify e2e went from 24.6s / 8 generations (and 60s+ timeouts) to ~5s / bounded rounds.
- **Thinking deltas** — the LLM `delta` event now carries an optional `reasoning` field when the provider streams thinking tokens separately from content (OpenRouter `reasoning`, DeepSeek `reasoning_content`); `bun scripts/latency-profile.ts` reports whether a model thinks before it speaks, through the same adapter path (the raw-fetch thinking probe was removed).
- **Tool-mode encodings** — `LLMRequest.toolMode` (and the matching adapter option, which the request overrides) selects how tool calls are encoded on the wire: `native` (provider `tools`/`tool_calls`, default), `envelope` (`response_format` JSON envelope translated back into `tool_call` events — for endpoints with structured outputs but no native tool calling), or `prompted` (the same envelope requested by instruction — the universal fallback). Every mode yields the same event surface, so agents and the orchestrator never change. In `envelope`/`prompted` modes the adapter injects a system-level tool contract (names, descriptions, and the envelope output rule) and embeds each tool's argument schema in the envelope, so the model sees the same argument contract it would in native mode.
- **ToolModeBenchmark** — a diagnostic class (exported from `@moureau/pipeflow/providers/llm`) that benchmarks the three tool modes through the real adapter path, reporting per-mode availability, p50/p95/p99 decision latency, median per-decision cost, correctness (every emitted call's arguments validated against the probe schema — a call with garbage args is a failed decision), and effective `$ / correct decision`. `bun scripts/envelope-vs-native.ts` wraps it as a CLI; `scripts/tool-envelope-probe.ts` gates a model's envelope validity when onboarding.
- **Favorite models list** — `ToolModeBenchmark` ships `FAVORITE_MODELS` (the seven models measured as usable: llama-4-scout, gemini-2.5-flash-lite, nova-micro, nova-lite, ling-3.0-flash, lunaris-8b, gpt-oss-20b) plus the `StringOr`/`FavoriteModel` type — any model id, with the favorites autocompleted — and `bun scripts/envelope-vs-native.ts` benchmarks them by default (`MODELS=...` overrides).
- **Tool argument schemas** — `Tool`/`PipeflowTool` accepts `schema: { in, out }` (zod): `in` derives the LLM-facing JSON parameters, `out` (defaulting to `in`) validates the arguments at `execute()` time and may transform them. One schema keeps the model contract and the `execute` signature in sync and turns garbage model arguments into a clear tool error instead of a crash inside the tool. `parameters` remains as the hand-written-JSON-schema escape hatch (mutually exclusive).
- **OpenRouter STT adapter** — `OpenRouterSTT` transcribes through the `/api/v1/audio/transcriptions` endpoint (default model `openai/whisper-large-v3-turbo`). OpenRouter's STT is batch-only, so the session buffers the incoming linear16 PCM, wraps each utterance in a WAV container, and transcribes a clip after `silenceMs` (default 800ms) of silence, emitting one `final` per clip (`end()` flushes the tail, `cancel()` aborts). No interim results — no `partial` events.
- **OpenRouter TTS adapter** — `OpenRouterTTS` synthesizes through the OpenAI-compatible `/api/v1/audio/speech` endpoint (default model `fish-audio/s2.1-pro-free:free`), returning raw audio bytes re-chunked for playback. `pcm` output by default (mp3 on request), `voice`/`speed` pass-through (set `voice: "alloy"` for a consistent voice on fish), and `stop()` aborts the in-flight synthesis.

### Fixed

- **Provider failures surface as errors** — the OpenAI-compatible streaming engine now emits an `error` event when a provider returns HTTP 200 with `finish_reason: "error"`/`"content_filter"` (e.g. gemini models via OpenRouter), instead of silently completing with an empty generation.
- **Stalled streams abort instead of hanging** — an `idleTimeoutMs` watchdog (default 8s) cancels a provider stream that delivers no data, closing the connection and surfacing a clear error. Protects against the observed failure where a model emits its full decision (e.g. a tool call) and the stream then never terminates (OpenRouter/nova showed ~28s stalls). Raise `idleTimeoutMs` for providers with slow first tokens.
- **Errored coordinations finalize their generation** — an LLM failure inside a coordination run previously left a dangling `streaming` generation in persistence; it is now completed (with the error surfaced via the `error` event), matching the agent path.
- **Tool calls are emitted exactly once** — the streaming engine no longer re-emits a tool call when a provider repeats the `finish_reason: "tool_calls"` chunk (gemini does this via OpenRouter), which previously caused a double `resolveToolCall` in the application.
- **Provider mid-stream aborts surface as errors** — providers that abort a stream and deliver the failure as an SSE chunk with no choices (e.g. Amazon Bedrock 504s via OpenRouter, observed on nova models) previously left an empty stream that surfaced as a confusing "model did not return a JSON envelope" error. The abort is now reported as a proper `error` event ("provider aborted the stream: …").
- **Envelope-mode repair** — `prompted`/`envelope` replies that wrap the JSON in markdown fences or prose (common without `response_format` guarantees) are extracted before parsing, and envelopes whose opening bytes were dropped in transport (observed with llama-4-scout via OpenRouter) are repaired by prepending the brace — both otherwise failed with a misleading parse error.
- **Clarify e2e no longer hard-fails on slow models** — the chain test reports a stall gracefully instead of timing out the whole suite.

## [0.0.1] - 2026-08-16

Initial release: a realtime voice infrastructure SDK for TypeScript.

### Added

- **Pipeflow entry point** — configure LLM/STT/TTS providers and persistence; create agents and conversations.
- **Agents** — personas with a system context and tools; `run()` for standalone LLM workloads with an agentic tool-call loop (streamed deltas, tool execution, chained history).
- **Tools** — typed `execute` callbacks with JSON-schema parameters and validation; `PipeflowTool` alias. Tools execute in the application's backend, never inside Pipeflow.
- **Conversations** — persistent realtime conversations with `create()`/`start()`/`participate()`/`listen()`/`stop()`, synchronous audio intake, multi-participant support with aliases, and a typed event stream (`audio-in`, `partial-transcript`, `turn`, `transcript`, `audio`, `generation`, `tool-call`, `interrupt`, `error`, `start`/`stop`/`state`).
- **Interruption** — `conversation.interrupt()` plus automatic barge-in when a participant speaks while the agent is responding.
- **Tool calls in conversations** — the orchestrator emits `tool-call` events; the application executes tools in its own backend and reports results back through `resolveToolCall()`, with configurable timeouts.
- **Orchestrator** — the realtime pipeline (audio → STT → turns → LLM → TTS → audio), sentence-buffered speech so the agent can narrate while tools run, generation epochs that discard stale results after interruption, multi-turn history rehydrated from persistence, and transcription-only mode for meetings without an agent.
- **Transcription** — transcript entries with speaker attribution and `toString()`; transcript retrieval is independent of `stop()`.
- **Providers** — vendor-independent LLM/STT/TTS interfaces, plus adapters for DeepSeek (SSE streaming with tool calls), Deepgram (WebSocket streaming with partials/finals), and Kokoro (chunked audio).
- **Persistence** — provider-independent storage interface with in-memory and SQLite (`bun:sqlite`) adapters, backed by a shared contract test suite.
- **Transport** — typed message protocol with an in-memory paired transport.
- **Packaging** — dual ESM/CJS builds, TypeScript declarations, subpath exports (`@moureau/pipeflow/providers`, `@moureau/pipeflow/persistence`, `@moureau/pipeflow/transport`), one runtime dependency (zod), and a GitHub Actions publish workflow.
- **Testing** — a 200+ test suite covering the full pipeline with fake providers: streaming, tool pause/resume and timeouts, interruption and barge-in, multi-turn clarification, persistence contracts, and provider adapters.

### Known limitations

- The SQLite adapter uses `bun:sqlite` and requires the Bun runtime; Node consumers should use the in-memory adapter.
- Multi-participant floor management and richer addressing heuristics are planned but not yet implemented; basic addressing by agent name/alias is implemented.
- The package is not yet published to npm.
