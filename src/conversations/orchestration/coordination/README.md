# Coordination

A hardcoded reasoning/control-flow unit. Unlike an `Agent` — which performs a
task (`input → LLM → output`) — a coordination decides **what should happen
next** in order to produce a desired result.

> Agent: *performs* the work.
>
> Coordination: *decides* who should do the work, whether more information is
> needed, and when the result is ready.

Coordinations are infrastructure, not user-facing capabilities: Pipeflow ships
the `understand` coordination that drives unaddressed turns, and applications
never define their own unless they opt into the power-user subpath.

## The loop

A coordination's LLM is given a single synthetic `delegate` tool. It streams
its reasoning/narration and, when it decides, takes exactly one action:

| Action | Meaning |
| --- | --- |
| `agents` | Run one or more agents **in parallel**, each with a self-contained prompt. The results come back as a tool message. |
| `coordination` | Pass the work to another registered coordination. Its output comes back as a tool message. |
| `user` | Ask the user a clarifying question and **suspend** until they answer. |
| `complete` | Finish with the final spoken answer. |

```jsonc
delegate({
  action: "agents",
  tasks: [
    { agent: "Travel Agent", prompt: "Find flights Paris → London tomorrow morning." },
    { agent: "Calendar Agent", prompt: "Check meetings on Tuesday afternoon." }
  ]
})
```

Every coordination can take every action — there is no "root coordinator"
versus "sub-coordinator." Coordinations can delegate to each other, forming an
execution graph; a **step budget** guards against runaway delegation and cycles.

## Suspension & resume

When a coordination asks the user, it throws a `CoordinationSuspension`
carrying its **frame stack** (outermost first). The orchestrator catches it,
records the question (transcript + history), and parks the frames. The next
user turn **resumes the same execution** — `resume(state, answer)` — instead of
starting fresh. A suspension inside a nested coordination parks the whole
stack; the answer resumes the innermost frame and the result propagates back
up through the parents.

This is what makes clarification flows work:

```text
Coordination A
     │
     ▼
   ask user
     │
     │  (parked)
     ▼
   user answers
     │
     ▼
Coordination A resumes → completes
```

## Contracts

- `Coordination` — definition (`name`, `prompt`, optional `llm`, `maxTokens`,
  `maxDurationMs`) + `run(input?)` / `resume(state, answer)` /
  `continueWith(state, message)`.
- `CoordinationRuntime` — what a coordination reasons against: the roster,
  registered coordinations, shared history, and primitives (`delegateAgentTasks`,
  `askUser`, speech hooks, `isCancelled`, `checkBudget`). Supplied by the
  orchestrator — coordinations never couple to it directly.
- The `delegate` tool's parameters are generated with **zod** (`z.toJSONSchema`)
  and its output validated by a strict discriminated union, so malformed
  arguments become tool errors the coordination's LLM can recover from rather
  than crashes.

## Notes

- Coordinations run on the orchestrator's shared LLM (or a per-coordination
  `llm` override); agents keep their own.
- Delegated agents run **text-only** — only the coordination narrates and
  speaks.
- See the [orchestrator README](../orchestrator/README.md) for how coordinations
  are wired into the realtime pipeline, and the root [README](../../../../README.md)
  for the public API.
