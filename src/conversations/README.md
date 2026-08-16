# Conversations

The persistent conversation domain. A `Conversation` is a runtime handle to a
persistent realtime conversation: lifecycle, participants, audio intake,
transcripts, and events.

```text
conversations/
├── conversation/       the Conversation runtime handle
├── orchestration/      the realtime pipeline (orchestrator + coordination)
├── transcription/      the in-memory transcript model
├── types.ts            core domain types (Turn, Generation, Participant, …)
└── conversations.ts    the Conversations API (create / transcript / get)
```

## Concepts

- **Conversation** — lifecycle (`start`/`stop`), participants, `listen()`,
  events. `start()` attaches the orchestrator when an STT provider is
  configured. See [conversation/README.md](./conversation/README.md).
- **Transcription** — ordered transcript entries with speaker attribution
  (`participant` | `agent`). See
  [transcription/README.md](./transcription/README.md).
- **Orchestration** — the realtime state machine and coordination layer. See
  [orchestration/README.md](./orchestration/README.md).
- **Turns & generations** — a `Turn` is a finalized participant utterance; a
  `Generation` is an agent response (with `kind: "sub"` for delegated work and
  `parentGenerationId` linking sub-generations to the coordinator that
  dispatched them).

## Public surface

- `pipeflow.conversations.create({ agents })` → `Conversation`
- `pipeflow.conversations.transcript(id)` → `TranscriptEntry[]`
- `pipeflow.conversations.get(id)` → `Conversation | null`

Subpath exports (`@moureau/pipeflow/conversations` and
`@moureau/pipeflow/conversations/*`) expose `Conversation`, `Conversations`,
`Orchestrator`, `Coordination`, transcription, and the domain types for power
users.

See the root [README](../../README.md) for the public API.
