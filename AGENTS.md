# Pipeflow — AI Development Guide

## Critical rules

- **Do NOT commit or push any changes without explicit user consent.**

## JSDoc style

Keep doc comments clean, concise, plain English. No em dashes, no developer
anecdotes, no bug explanations. Describe what it is, not how it got that way.

## Documentation

After any significant change, check these files need updating:

- `README.md` — public API, status table, examples
- `CHANGELOG.md` — add to `[Unreleased]` section under Added/Fixed/Changed
- `llms.txt` — AI reference guide: exports, patterns, API surface
- `src/**/README.md` — subpath docs (transport, client, persistence, providers)

## Project

- Use `bun` instead of `node` or `npm`
- Run `bun test` for tests, `bun run build` to build, `bunx tsc --noEmit` for typecheck
- Use `zod` for schemas, no other runtime deps
- Exports from subpaths: `@moureau/pipeflow/providers`, `@moureau/pipeflow/persistence`, `@moureau/pipeflow/transport`, `@moureau/pipeflow/client`, `@moureau/pipeflow/conversations`

## Testing

- `bun test` runs everything (including e2e — slow, needs API keys)
- `bun run test:unit` for unit tests only (fast, no network) — use this after code changes
- `bun run test:e2e` for end-to-end tests against real LLM APIs
- Each module has a co-located `.test.ts` file next to the implementation
- Tests use `bun:test` (`describe`, `test`, `expect`) — no Jest
- Persistence adapters share a contract test suite in `src/persistence/contract-tests.ts`
