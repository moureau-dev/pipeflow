# Conversation

The public realtime conversation API — a runtime handle to a persistent
conversation.

```ts
const conversation = await pipeflow.conversations.create({
  agents: [jarvis],
});

await conversation.start();               // attaches the realtime pipeline
await conversation.participate({ userId: "alice" });
conversation.listen({ userId: "alice", audio });  // feed audio in (sync)
conversation.on("audio", (payload) => voice.play(payload.audio));
await conversation.stop();
```

## Lifecycle

- `create()` makes the persistent record; `start()` attaches the orchestrator
  (STT → routing → LLM → TTS). Creation and execution are deliberately
  separate. The orchestrator attaches whenever there is realtime work: an STT
  provider for voice, or agents with an LLM for text turns (`send()`).
- `stop()` finalizes the session, cancels in-flight generations (including
  sub-generations), and persists the end time.
- `interrupt()` is a semantic guarantee, not a performance hint: it stops the
  currently active generation and prevents any further generated audio from
  reaching the conversation (tested to stop audio within ~100ms). The next
  turn starts fresh.

## Events

`start`, `stop`, `participant`, `audio-in`, `text-in`, `audio`, `turn`,
`transcript`, `generation`, `text-delta`, `generation-complete`,
`partial-transcript`, `tool-call`, `tool-call-result`, `interrupt`, `error`,
`state`.

The orchestrator consumes `audio-in`, `text-in`, `interrupt`, and
`tool-call-result`; it pushes generated audio, turns, transcripts, and
generations back through the same event surface. `text-delta` streams the
current generation's text as LLM deltas arrive (including the agent name when
the generation is known); `generation-complete` fires exactly once when the
top-level generation finishes — the semantic boundary consumers can wait on.

## Tool calls

Agent tools auto-execute by default: the orchestrator runs the matching tool
and feeds the result back into the generation, so applications need no
`tool-call` handler. The `tool-call` and `tool-call-result` events still fire
for every call — for observation and logging. Set `autoExecuteTools: false`
on `Pipeflow`, `create()`, or the `Conversation` to take over: listen for
`tool-call` and resolve each call yourself with `resolveToolCall()`.

## Orchestrator-facing output

`pushTurn`, `pushTranscript`, `pushGeneration`, `pushTextDelta`,
`completeGeneration`, `pushSubGeneration` / `completeSubGeneration` /
`cancelSubGeneration`, `requestToolCall`, `resolveToolCall`. Sub-generations
live in their own store so parallel dispatched tasks never clobber the
coordinator's current generation.

## Notes

- `listen()` is intentionally synchronous: it means "send this audio packet",
  not "wait for this utterance to finish".
- `send({ userId, text })` injects a finalized text turn, bypassing STT —
  text-first integrations (chat, Discord text) get the same routing,
  coordination, and resume behavior as transcribed turns.
- The conversation does not require an agent — without one, `start()` runs in
  transcription-only mode (turns and transcripts out).

See the root [README](../../../README.md) for the public API.
