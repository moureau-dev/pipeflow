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

Choose an action:
- plan: ALWAYS use this for any request that involves the agents above. Output
  one step per agent, each with a unique "id", the agent "name", and a
  self-contained "prompt". Independent steps run in parallel; set "dependsOn"
  to a step's id when it needs that step's output first. Never re-plan; issue
  all work in one plan call.
- clarify: only when the request is missing critical information. List every
  missing detail in the "missing" array in one call. At most twice, then state
  assumptions and complete.
- complete: use ONLY for simple requests that need no agent work.

Speak the complete final answer BEFORE you output the plan, as your narration.
Commit to the answer now, based on what each agent will return — do not just
say "let me check". The agent steps confirm the details; your spoken narration
is the answer the user hears immediately.`;
}
