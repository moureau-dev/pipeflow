# Orchestrator

The realtime conversation state machine. It wires a conversation to the
providers (STT, LLM, TTS) and pushes everything back out through conversation
events.

```text
audio-in ──► STT ──► turn ──► router ──► agent / coordination ──► TTS ──► audio-out
                                                      │
                                                      └─► tool-call ──► app resolves ──► resume
```

`Conversation.start()` attaches an orchestrator automatically (with an STT
provider for voice, or agents with an LLM for text turns), so most
applications never construct one directly. The class is exported for power
users via `@moureau/pipeflow/conversations/orchestration/orchestrator`.

## Layout

The state machine itself stays thin — lifecycle, routing, epochs, and event
wiring — and composes focused collaborators:

```text
orchestrator/
├── orchestrator.ts           lifecycle + routing + event wiring
├── history/                  ConversationHistory: message log, turn-context
│                             suffix, windowing, rehydration
├── routing/                  pickAgent / findAddressedAgent / findAgentByName
├── generation/               GenerationRunner: the shared LLM + tool-call loop
├── speech/                   SpeechPipeline: delta → sentence chunker → TTS
├── tools/                    ToolCallManager: tool-call waiters, timeouts,
│                             cancellation
└── coordination-runner/      CoordinationRunner: suspension/resume stack,
                              budgets, delegation
```

## Routing

Each finalized participant turn is routed:

1. **Pending coordination?** → the parked coordination resumes with this turn
   (`CoordinationRunner.resume`). The user answered a pending question; the
   execution continues from the suspension.
2. **Explicitly addressed** (an agent's name or alias appears in the text), or
   a **single-agent** conversation → straight to that agent as a full
   generation.
3. **Otherwise** → the built-in `understand` coordination decides: delegate to
   agents, pass to another coordination, ask the user, or answer directly.

## Realtime behaviors

- **Context suffix**: every user turn automatically carries a short context
  suffix — the time, the speaker's identity (user id + aliases), and the other
  participants — so the model can reason about "now" and "me" (e.g. "enhance
  the message I just sent" resolves to a real user id the application's tools
  can act on). Applied once when the turn enters history; every generation
  path (direct, coordination, delegated) inherits it.
- **Streaming**: LLM deltas are buffered into sentences and synthesized to TTS
  immediately; audio chunks reach the application as `audio` events.
- **Tool calls** pause the generation; the application resolves them through
  `tool-call` / `resolveToolCall` events. Agent tools always run in *your*
  backend.
- **Interruption**: `interrupt()` bumps a generation epoch, aborts every LLM
  and TTS stream, force-resolves tool waiters, and discards the cancelled
  generation from the transcript.
- **Barge-in**: participant speech during a generation interrupts it
  automatically — *except* while a coordination is waiting for the user, where
  the speech is treated as the answer (TTS playback stops, the execution stays
  parked).
- **Suspension**: coordination questions park a resumable frame stack
  (`PendingExecution`); the next turn resumes it. See the
  [coordination README](../coordination/README.md).

## Guarantees

- `whenIdle()` resolves once every queued/in-flight turn and generation has
  finished (including coordinations) — used by tests and graceful shutdown.
- Generations, turns, transcripts, and sub-generations persist through the
  `Persistence` adapter; interrupted work is recorded as `cancelled`, never
  half-completed.
- Coordination reasoning is bounded by `maxCoordinationSteps` (default 20) and
  per-coordination `maxDurationMs`; delegated agents are bounded by
  `maxToolIterations`.

## Options

`OrchestratorOptions` — `conversation`, `agents`, `llm` (defaults to the first
agent's), `stt`, `tts`, `persistence`, `toolTimeoutMs`, `maxToolIterations`,
`coordinations` (a name-keyed record of extra coordination definitions, e.g.
`{ clarify: { prompt: buildClarifyPrompt() } }`), `maxCoordinationSteps`,
`temperature`, `maxTokens`, `historyWindow` (default `{ maxTurns: 5,
maxChars: 4000 }` — bounds the conversation history each LLM request carries,
since provider TTFT grows with input size; pass `false` to always send the
full history).

## Notes

- The orchestrator is intentionally not part of the small public API; the
  [conversation](../../conversation/README.md) is the runtime handle
  applications interact with.
- See the [coordination README](../coordination/README.md) for the reasoning
  layer and the root [README](../../../../README.md) for the public API.
