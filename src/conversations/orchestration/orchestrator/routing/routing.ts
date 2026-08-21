import type { Agent } from "../../../../agents/agent";

/**
 * Pick the agent that should handle a turn.
 *
 * The first agent whose name or alias appears in the turn text wins;
 * otherwise the first agent in the roster is the default. Matching is
 * case-insensitive substring matching, so "ask the technical specialist"
 * addresses an agent named "Technical Specialist" (or aliased "tech").
 */
export function pickAgent(agents: readonly Agent[], text: string): Agent | null {
  if (agents.length === 0) return null;
  const normalized = text.toLowerCase();
  for (const agent of agents) {
    if (agent.name && normalized.includes(agent.name.toLowerCase())) return agent;
    for (const alias of agent.aliases) {
      if (normalized.includes(alias.toLowerCase())) return agent;
    }
  }
  return agents[0]!;
}

/**
 * Like `pickAgent` but without the default: only returns an agent the turn
 * explicitly addresses by name or alias.
 */
export function findAddressedAgent(
  agents: readonly Agent[],
  text: string,
): Agent | null {
  const normalized = text.toLowerCase();
  for (const agent of agents) {
    if (agent.name && normalized.includes(agent.name.toLowerCase())) return agent;
    for (const alias of agent.aliases) {
      if (normalized.includes(alias.toLowerCase())) return agent;
    }
  }
  return null;
}

/** Resolve a task's agent by exact name or alias (case-insensitive). */
export function findAgentByName(
  agents: readonly Agent[],
  nameOrAlias: string,
): Agent | null {
  const normalized = nameOrAlias.trim().toLowerCase();
  for (const agent of agents) {
    if (agent.name.toLowerCase() === normalized) return agent;
    for (const alias of agent.aliases) {
      if (alias.toLowerCase() === normalized) return agent;
    }
  }
  return null;
}

/** The built-in coordinator: understands the request and decides what's next. */
export function buildUnderstandPrompt(agents: readonly Agent[]): string {
  const roster = agents
    .map((agent) => {
      const aliases =
        agent.aliases.length > 0 ? ` (aliases: ${agent.aliases.join(", ")})` : "";
      return `- ${agent.name}${aliases}`;
    })
    .join("\n");
  return `You are the conversation coordinator.

Your job is to understand what the user is trying to accomplish and decide what
should happen next. You never perform domain work yourself.

The available agents are:
${roster}

Decide the best next step and take exactly one:
- delegate to one or more agents ("agents"), each with a self-contained prompt
  describing exactly what to do and any context they need;
- pass the work to another coordination ("coordination");
- ask the user for missing details ("clarify") when the request is ambiguous or
  missing critical information — batch every missing detail into the "missing"
  array in one call, never one question at a time. You may ask at most twice
  per request; after that, state reasonable assumptions and answer;
- answer directly ("complete") when you have everything you need.

When you delegate, briefly narrate what you are doing, wait for the results,
then compose a single concise spoken answer and complete. Do not narrate your
internal reasoning.`;
}
