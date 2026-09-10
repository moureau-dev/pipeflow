# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.4] - 2026-09-10

### Added

- **Pluggable logging** — `Pipeflow` accepts `logger` (implements `Logger` interface) or `verbose: true` shorthands. Ships `ConsoleLogger` and `SilentLogger`. The logger propagates through `Conversations`, `Conversation`, `Orchestrator`, and `CoordinationRunner`, logging creation, starts, stops, generation status, errors, and key lifecycle events. Exported from `@moureau/pipeflow`.
- **Server transport abstraction** — `ServerAdapter`/`ServerClient` interfaces let any runtime (Bun, Node `ws`, socket.io) bridge `Conversation` events to remote clients. Exported from `@moureau/pipeflow/transport`.
- **Per-conversation LLM abort isolation** — `LLMRequest.signal` allows each orchestrator to abort its own generation without affecting other conversations sharing the same LLM instance. `onInterrupt()` and `stop()` now use this per-conversation `AbortController` instead of calling `llm.stop()` (which previously aborted all streams on that LLM instance, regardless of which conversation owned them).
- **Event-driven `whenIdle()`** — replaced busy-wait polling with a promise-based notification, eliminating CPU spin during test idle detection.
- **Conversation listing with filters** — `pipeflow.conversations.list()` accepts `userId`, `status`, `archived`, `orderBy`, `orderDir`, `page`, and `pageSize` filters. Returns `{ conversations, total }` for paginated UIs. Excludes archived conversations by default.
- **Conversation archiving** — `pipeflow.conversations.archive(id)` soft-deletes by setting `archivedAt`. Archived conversations are hidden from `list()` but still retrievable via `get()`. Filter with `list({ archived: true })`.
- **`createdBy` field** — conversations can be tagged with the creating user's id. Filtered via `list({ userId })`.
- **Client `generation-complete` and `text-delta` events** — `PipeflowClient` now dispatches `generation-complete` and `text-delta` events, letting the server decide whether to forward streaming text deltas to clients.

### Fixed

- **Cross-conversation interrupt contamination** — interrupting one conversation no longer cancels generations in other conversations sharing the same LLM instance. Previously `onInterrupt` called `llm.stop()` which aborted every in-flight stream on that LLM instance. Now each orchestrator owns its own `AbortController` which only aborts its own streams.
- **Silent persistence errors** — `.catch(() => {})` replaced with `.catch((err) => logger.error(...))` on generation timing writes, so failures surface in logs instead of being silently swallowed.

### Changed

- **Removed busy-wait loop** — `Orchestrator.whenIdle()` now uses a microtask check + promise resolve instead of `while(…) { Bun.sleep(1) }`, eliminating CPU pegging.
- **`tsconfig.json` excludes `dist/`** — prevents stale build artifacts from polluting typecheck.

## [Unreleased]

### Added

- **Plan-based coordination** — the built-in `understand` coordination now
  outputs a structured plan (`action: "plan"`) with typed steps instead of a
  reactive delegation loop. Each step has an `id`, optional `agent`, `prompt`,
  and `dependsOn` (string ids). Independent steps run in parallel; dependent
  steps resolve in order and receive their dependency outputs injected into the
  prompt. This eliminates infinite re-delegation loops and makes multi-agent
  execution deterministic, observable, and bounded to one plan round.
- **`"plan"` event** — fires on the conversation when the coordinator produces a
  plan, giving the application visibility into the execution strategy before it
  runs.
- **`"plan-step"` event** — fires `started`/`completed`/`failed` per step with
  the step's output text, for progress UIs and status tracking.
- **`"agent-delta"` event** — a delegated specialist's LLM output streamed in
  realtime, tagged with the agent name. Distinct from `text-delta` (the top-level
  reply): this is live progress for UX observation and is not coalesced into the
  conversation's reply object.
- **`finalizeAfterToolRound` option** — sub-generations skip the redundant answer
  round after tool execution, synthesizing output directly from tool results.
  Cuts wall time ~30% and removes the post-tool LLM round trip.
- **`agents` action support** — the flattened `delegate` tool still accepts the
  simpler `action: "agents"` / `tasks` syntax alongside `plan`. Models that can't
  handle the full plan schema (e.g. nova-micro) use the simpler form, while
  `plan` supports dependencies and composition. Both route through the same
  deterministic executor.
- **Delegated sub-generation token cap** — sub-generations within a plan step
  bound output to 512 tokens and limit tool iterations to 3 (was 10), preventing
  runaway loops and long rambling.
- **`retryDirectAnswer` option** — on `Conversation.create()` / `Pipeflow`,
  when a multi-agent coordination answers directly without planning, the
  framework retries once. Off by default: a legitimate direct answer ("hello")
  cannot be reliably distinguished from a model that ignored planning.

### Changed

- **`understand` prompt tightened** — encourages the model to speak the full
  answer in its narration BEFORE emitting the tool call, eliminating the
  separate composition LLM round-trip for the common case. The `composition`
  field is still available for models that request it explicitly.
- **`delegate` tool description** — updated to emphasize planning as the
  primary action, removing the "decide what should happen next" framing that
  encouraged the reactive loop.

### Fixed

- **Sub-generation text deltas no longer pollute the conversation stream** —
  specialist output now streams through `agent-delta` instead of `text-delta`,
  so the top-level reply object (coalesced by `ConversationStream`) is not
  fragmented by intermediary agent narration.

## [0.0.3] - 2026-09-07

### Added

- **Server-side audio reordering (`listen({ sequence })`)** — `Conversation`
  gains netcode-style reordering before STT, like client-side prediction in
  multiplayer games: transports and client transforms (async VAD, worker
  inference) can deliver audio out of order, so `listen()` now accepts the
  sender's capture-order `sequence` and reorders per participant before
  anything reaches the orchestrator. In-order chunks (the common case) are
  emitted immediately with no added latency; a chunk arriving ahead of a
  gap is held for `audioReorderMs` (default 100, set on `create()`) so a
  packet still in flight can fill it; when the window expires the gap is
  skipped and the buffer is released in order, and the late chunk is
  dropped. Late and duplicate sequences are always dropped, each
  participant's stream is independent (first chunk anchors the baseline),
  `stop()` clears the buffers, and without a `sequence` the chunk is
  emitted on arrival exactly as before. Emitted `audio-in` events keep
  their own conversation-level sequence, renumbered in release order —
  always increasing, so persistence and transcripts see clean ordering.
- **Async client capture transform** — `audio.transform` may now return a
  promise (worker/model-based VAD such as Silero, onnxruntime, anything via
  `postMessage`). Each chunk's `sequence` is assigned at capture time,
  pre-transform, so chunks sent out of order still mark their capture
  position and the server's reorder buffer restores capture order before
  STT. A transform slower than the capture rate loses audio at the gaps
  past the server's hold window — keep it faster than real-time. Sync
  transforms (energy gates) are unchanged.
- **Client capture gate (`audio.transform`)** — `PipeflowClient`'s built-in
  mic capture accepts `audio.transform(chunk)`: return a chunk to send it
  (possibly rewritten) or `null` to drop it — the seam for client-side VAD
  (energy gate, Silero, WebRTC, …) without reimplementing the capture
  plumbing. It applies only to captured mic audio; manual `sendAudio()`
  calls hit the wire untouched, keeping the send path a faithful transport
  so gating policy lives only where capture was explicitly opted into. A
  throwing transform surfaces an `error` event and drops the chunk without
  stopping the capture loop.
- **Explicit mic capture constraints** — the client's mic now opens with
  `echoCancellation`, `noiseSuppression`, and `autoGainControl` on by
  default (overridable via `audio.constraints`). Without echo cancellation
  the speaker's audio re-enters the mic, the server hears the agent's own
  reply, and barge-in self-triggers in a feedback loop; noise suppression
  keeps pops and room tone from becoming transcribed stage directions. The
  example's client already set these by hand — the SDK now does it by
  default.
- **Browser/Node client SDK** — `@moureau/pipeflow/client` ships a typed
  `PipeflowClient` that mirrors the `Conversation` event surface (`start`,
  `stop`, `turn`, `transcript`, `audio`, `generation`, `tool-call`,
  `tool-call-result`, `interrupt`, `error`, …) over a swappable `Protocol`
  wire. Ships a `WebSocketProtocol` (lazy token provider appended as
  `?token=`); bring your own SSE / WebRTC / custom transport by implementing
  the 4-method `Protocol` contract. Optional mic capture (`audio.input`),
  exponential-backoff auto-reconnect, and a JSON-serializability guard on
  outbound payloads.

- **Whisper hallucination filter** — `OpenRouterSTT` cleans transcripts by
  default before emission: asterisk stage directions (`*Dramatic music*`) are
  dropped, consecutive repeated sentences (`Thank you. Thank you.`) collapse
  to one, and transcripts built *entirely* from conversational fillers — the
  built-in multilingual list (English, Portuguese, Spanish, French, German)
  plus `fillerPhrases` extras, repeated or not (`E aí`, `E aí E aí`, `ok ok
  thank you`) — are suppressed. `filterHallucinations: false` returns raw
  transcripts. These artifacts come from near-silence clips
  and speaker echo, so the example also trims trailing silence and enables
  `echoCancellation`/`noiseSuppression` at the mic.
- **Clip-level energy floor** — `OpenRouterSTT` accepts `minClipRms`
  (0–1 RMS): buffered `pcm` clips below the floor — the near-silence ones
  whisper hallucinates on — are dropped *before* transcription, so no request
  is sent, no `final` fires, and no fabricated turn reaches the conversation
  (or interrupts a generation). The client's VAD gates what is sent; this
  gates what is transcribed. `onClipEnergy` reports every measured clip's RMS
  and whether it was transcribed, for tuning the floor against your real
  distribution (speech clips sit far above artifact clips). The floor is
  live-tunable (`stt.minClipRms = …`, no session restart) and the example's
  client has a slider for it, showing each clip's RMS as you drag.
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

- **Transient no-output LLM failures are retried once** — nova models served
  from Bedrock via OpenRouter intermittently abort the chat stream right
  after it starts (the client saw "OpenRouter provider aborted the stream:
  The operation was aborted"), killing the whole generation and forcing the
  user to re-ask. When a generation fails *before any text was produced and
  no tool executed*, the orchestrator retries it once with a fresh request
  (mid-stream aborts, idle timeouts, 429/5xx). Partial output or executed
  tools are never retried — that would double-speak or re-run side effects.

- **TTS and STT requests can no longer hang the pipeline indefinitely** — a
  provider connection that never responded (or went silent mid-stream) held
  the pipeline open forever: a stuck TTS synthesis wedged the speech delivery
  chain (the reply waited for the next user input, whose barge-in aborted it),
  and a stuck transcription blocked the STT session's serialized queue for the
  rest of the server's life. The OpenRouter TTS adapter now aborts a synthesis
  that delivers no audio for `idleTimeoutMs` (default 15s, option on the
  adapter), and the OpenRouter STT adapter aborts a transcription that takes
  longer than `transcriptionTimeoutMs` (default 30s) — both surface a clear
  error and the pipeline moves on.

- **TTS concurrency is tunable and the example stops defaulting to a flaky
  model** — remote TTS takes ~1.3-2s per sentence request, so with the old
  2-in-flight window the sentences of a reply arrived ~1s apart (audible gaps)
  and the free fish variant OpenRouter served was intermittently unavailable
  (404 "No endpoints found" → dropped sentence audio). Conversations now accept
  `maxConcurrentTtsRequests` (threaded to the speech pipeline, default 2) so
  sentences synthesize in parallel, and the example defaults to the steady
  paid `fish-audio/s2.1-pro` (`TTS_MODEL=...:free` to opt back into the free
  variant).

- **Inline `<thinking>` tags no longer leak into the reply** — reasoning
  models whose serving layer lacks a native reasoning channel (e.g.
  `amazon/nova-micro` via OpenRouter in a thinking mode) stream their chain
  of thought as visible `<thinking>…</thinking>` tags inside the content, so
  the "thoughts" were displayed and read aloud by TTS. The OpenAI-compatible
  adapter now partitions the tags out of the content stream (handling tags
  split across chunks) and surfaces the inner text on the existing
  `reasoning` field — measured/displayable, but never spoken or written into
  the reply text, transcript, or history.

- **Single-agent conversations stop leaking the agent's name into prompts** —
  system and assistant messages carried a per-agent `name` field even when the
  conversation had one agent, where it is redundant. Some providers render
  that `name` as a role header ("Scout:"), and smaller models imitate it —
  every reply then starts by speaking the agent's name. Multi-agent
  conversations (where names disambiguate who said what) keep them.

- **Prompted tool mode answers plain prose instead of failing** — models that
  ignore the envelope instruction and reply conversationally (common on
  smaller chat models like `amazon/nova-micro`) previously errored the whole
  generation with "model did not return a JSON envelope". The reply is now
  treated as the model's answer and spoken normally; the prompt also tells the
  model plain text is fine when no tool is needed. Output that clearly
  attempted a (broken/truncated) envelope still errors.

- **TTS synthesis is bounded to a small queue** — the speech pipeline fired
  one synthesis request per sentence the moment it was flushed, so a reply
  with many sentences launched an unbounded burst of concurrent provider
  requests (free TTS variants rate-limit those, and later sentences were
  frequently cut off or errored). Sentences now synthesize through a bounded
  window (2 in-flight requests by default; `SpeechPipeline` accepts
  `maxConcurrentRequests`), started as soon as a slot is free so the next
  sentence overlaps the current one's playback and the first piece is never
  held up by the last. `waitForIdle()` now also covers sentences still waiting
  on a slot.

- **Clip boundaries freeze at silence detection** — the OpenRouter STT
  adapter previously took its buffer when the serialized transcription
  callback ran, not when the silence that ended the clip was detected. If a
  previous clip was still being transcribed, a late-running flush swept the
  start of the next utterance into the wrong clip (or merged utterances
  separated by a full silence gap into one turn). The buffer is now captured
  synchronously in `flush()` — the audio that arrives while a transcription
  is in flight starts its own clip.

- **Example tool handler removed** — the WebSocket example no longer
  hand-wires `tool-call` → `resolveToolCall` (with an unsafe `execute` cast);
  the agent's `get_weather` tool auto-executes.

- **Barge-in cuts the agent's audio on the client** — the example previously
  kept playing already-synthesized sentences after an interrupt (the server
  aborts generation, but queued mp3 frames were still in the client's
  playback queue). The server now forwards the conversation's `interrupt`
  event and the client cuts the current buffer and drops the queue the moment
  the mic hears the user, on a new turn, or on the server message.
- **Mic taps no longer interrupt the agent** — the client previously cut
  playback on the *first* voiced buffer, so a tap or pop (a single 256ms
  transient) stopped the agent mid-sentence. Barge-in now fires only on
  *confirmed* speech — a short burst of voiced ~32ms frames — so a tap never
  interrupts, and the gate now reacts in ~200ms instead of the ~770ms the old
  three-buffer streak cost.
- **Example mic VAD stops eating and duplicating audio** — the buffer-level
  VAD dropped the first voiced 256ms buffer (clipped word onsets — the eaten
  first letter) and then sent the confirming buffer a second time (whisper
  heard one 256ms window twice and echoed words back). Clips also began
  abruptly at speech, with no lead-in silence, and ended after a single
  silent block — the exact input whisper loop-hallucinates on ("to the back,
  to the back…", repeated words). The client now decides on ~32ms frames,
  holds an idle pre-roll so every clip starts with real lead-in silence
  before the first voiced frame, requires a genuine speech burst so short
  words ("sim") register, and appends ~450ms of trailing silence so the last
  word isn't cut off.
- **Truncated replies are marked** — when an interrupt or a new user turn
  cuts the agent mid-response, the client appends "…" to the partial line so
  a cut-off answer is visually distinct from a completed one. The user's own
  lines get the same treatment: when a new utterance starts before the
  previous clip's turn comes back from STT, that turn was a slice of
  continued speech and is marked "…" too.
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
