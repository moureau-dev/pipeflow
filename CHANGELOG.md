# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **Packaging** — dual ESM/CJS builds, TypeScript declarations, subpath exports (`@moureau/pipeflow/providers`, `@moureau/pipeflow/persistence`, `@moureau/pipeflow/transport`), zero runtime dependencies, and a GitHub Actions publish workflow.
- **Testing** — a 196-test suite covering the full pipeline with fake providers: streaming, tool pause/resume and timeouts, interruption and barge-in, multi-turn clarification, persistence contracts, and provider adapters.

### Known limitations

- The SQLite adapter uses `bun:sqlite` and requires the Bun runtime; Node consumers should use the in-memory adapter.
- Multi-participant floor management and addressing (determining when an agent is being spoken to) are planned but not yet implemented.
- The package is not yet published to npm.
