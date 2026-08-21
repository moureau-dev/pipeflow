# Orchestration

The realtime reasoning layer of a conversation.

```text
conversations/orchestration/
├── orchestrator/   the realtime state machine (STT → routing → LLM → TTS)
└── coordination/   hardcoded reasoning units that decide what happens next
```

- **Orchestrator** — attaches to a conversation, routes turns, drives the
  streaming pipeline, handles interruptions/barge-in, and executes tool calls.
  The state machine composes focused collaborators for history, routing,
  generation, speech, tools, and coordination execution.
  See [orchestrator/README.md](./orchestrator/README.md).
- **Coordination** — the `understand` reasoning loop and the `delegate` tool
  contract (agents / coordination / user / complete), including suspension and
  resume. See [coordination/README.md](./coordination/README.md).

Both are internal implementation detail: `Conversation.start()` wires them up
automatically. Power users can reach them through the
`@moureau/pipeflow/conversations/orchestration/...` subpaths.

See the root [README](../../../README.md) for the public API.
