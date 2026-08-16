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
  separate.
- `stop()` finalizes the session, cancels in-flight generations (including
  sub-generations), and persists the end time.
- `interrupt()` is a semantic guarantee, not a performance hint: it stops the
  currently active generation and prevents any further generated audio from
  reaching the conversation (tested to stop audio within ~100ms). The next
  turn starts fresh.

## Events

`start`, `stop`, `participant`, `audio-in`, `audio`, `turn`, `transcript`,
`generation`, `partial-transcript`, `tool-call`, `tool-call-result`,
`interrupt`, `error`, `state`.

The orchestrator consumes `audio-in`, `interrupt`, and `tool-call-result`; it
pushes generated audio, turns, transcripts, and generations back through the
same event surface.

## Orchestrator-facing output

`pushTurn`, `pushTranscript`, `pushGeneration`, `completeGeneration`,
`pushSubGeneration` / `completeSubGeneration` / `cancelSubGeneration`,
`requestToolCall`, `resolveToolCall`. Sub-generations live in their own store so
parallel dispatched tasks never clobber the coordinator's current generation.

## Notes

- `listen()` is intentionally synchronous: it means "send this audio packet",
  not "wait for this utterance to finish".
- The conversation does not require an agent — without one, `start()` runs in
  transcription-only mode (turns and transcripts out).

See the root [README](../../../README.md) for the public API.
