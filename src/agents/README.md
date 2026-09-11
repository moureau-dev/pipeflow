# Agents

An agent defines an AI persona and its capabilities.

```ts
const jarvis = pipeflow.agent({
  name: "Jarvis",
  aliases: ["jay"],                 // names a participant might use to address it
  context: "You are concise and helpful.",
  tools: [getWeather],
  llm: myCustomLLM,                 // optional: override the shared LLM
});
```

## Concepts

- **Agent** — a name, aliases, a system context, a set of tools, and an LLM.
  It *performs* work: `input → LLM → output`, executing tools along the way.
  See `agent.ts`.
- **Tool** — a capability exposed from *your* backend: a name, a description,
  and an `execute()` function. In a conversation the orchestrator runs it
  automatically (auto-execute, like `run()`) and feeds the result back; with
  `autoExecuteTools: false` it emits `tool-call` events and your application
  executes and resolves them. See `tools/tools.ts`.
- **`run()`** — invoke an agent standalone (no conversation): streams the LLM,
  executes any requested tools, and returns the final text plus the full
  message history and executed tool calls. Tool calls the model requests
  together execute concurrently.

## Dynamic context

`context` accepts either a static string or a `ContextFn`:

```ts
// Static
pipeflow.agent({ name: "Jarvis", context: "You are helpful." });

// Dynamic — called per generation with the turn and app state
pipeflow.agent({
  name: "DocBot",
  context: ({ prompt, annotations }) =>
    `Current file: ${annotations.get("currentFile") ?? "none"}. ` +
    `Help with: "${prompt}"`,
});
```

`ContextFn` receives `ContextParams`: `prompt`, `conversationId`,
`participants`, `turn`, and `annotations` (always present, empty when
standalone). Sync or async.

## Agents vs coordinations

An agent performs a task. A coordination (see
[conversations/orchestration/coordination](../conversations/orchestration/coordination/README.md))
decides *what should happen next* — including which agent should perform it.

In a conversation:

- Explicitly addressed turns go straight to the agent.
- Delegated agents run text-only as sub-generations with their own LLM,
  context, and tools; only the coordination narrates and speaks.

See the root [README](../../README.md) for the public API.
