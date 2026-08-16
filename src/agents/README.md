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
  and an `execute()` function. Tools never run inside Pipeflow — the
  orchestrator emits `tool-call` events and your application resolves them.
  See `tools/tools.ts`.
- **`run()`** — invoke an agent standalone (no conversation): streams the LLM,
  executes any requested tools, and returns the final text plus the full
  message history and executed tool calls. Tool calls the model requests
  together execute concurrently.

## Agents vs coordinations

An agent performs a task. A coordination (see
[conversations/orchestration/coordination](../conversations/orchestration/coordination/README.md))
decides *what should happen next* — including which agent should perform it.

In a conversation:

- Explicitly addressed turns go straight to the agent.
- Delegated agents run text-only as sub-generations with their own LLM,
  context, and tools; only the coordination narrates and speaks.

See the root [README](../../README.md) for the public API.
