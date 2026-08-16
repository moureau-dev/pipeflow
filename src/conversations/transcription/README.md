# Transcription

The in-memory transcript model for a conversation: an ordered list of
`TranscriptEntry` lines with speaker attribution.

```ts
export type TranscriptSpeakerKind = "participant" | "agent";

new TranscriptEntry({ conversationId, speaker: "alice", speakerKind: "participant", text: "Hello" });
entry.toString(); // "alice: Hello"
```

## Model

- Entries are immutable, appended in order, and assigned monotonically
  increasing sequence numbers.
- `speakerKind` distinguishes participant turns from agent generations
  (including delegated sub-agent work and coordination questions).
- `TranscriptEntry.fromPlain()` rebuilds entries from persisted data.

The orchestrator appends entries as participant turns finalize, sub-agents
report, coordinations ask questions, and generations complete. Persistence
mirrors the same entries through `appendTranscript` / `listTranscript`, so
`pipeflow.conversations.transcript(id)` returns the full conversation.

See the root [README](../../../README.md) for the public API.
