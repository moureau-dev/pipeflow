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

## File structure

Each module lives in its own folder with three files:

- `<name>.ts` — implementation
- `<name>.test.ts` — co-located tests
- `index.ts` — barrel exports

Optionally a `README.md` for subpath documentation.

```

src/
├── agents/
│   └── agent.ts, agent.test.ts, index.ts
│       └── tools/
│           └── tools.ts, tools.test.ts, index.ts
├── client/
│   └── client.ts, client.test.ts, index.ts
│       └── protocol/
│           └── websocket.ts, websocket.test.ts
├── conversations/
│   ├── conversation/
│   │   └── conversation.ts, conversation.test.ts, index.ts
│   ├── orchestration/
│   │   ├── orchestrator/
│   │   │   └── orchestrator.ts, orchestrator.test.ts, index.ts
│   │   ├── coordination/
│   │   │   └── coordination.ts, coordination.test.ts, index.ts
│   │   └── ...
│   └── transcription/
│       └── transcription.ts, transcription.test.ts, index.ts
├── logger/
│   └── types.ts, console.ts, console.test.ts, index.ts
├── persistence/
│   ├── persistence.ts, contract-tests.ts, index.ts
│   └── adapters/
│       ├── memory/
│       │   └── memory.ts, memory.test.ts, index.ts
│       └── sqlite/
│           └── sqlite.ts, sqlite.test.ts, index.ts
├── providers/
│   ├── llm/
│   │   ├── types.ts
│   │   ├── adapters/
│   │   │   ├── openrouter/
│   │   │   ├── deepseek/
│   │   │   ├── openai/
│   │   │   ├── claude/
│   │   │   └── openai-compatible.ts — shared engine
│   │   └── index.ts
│   ├── stt/
│   └── tts/
│       └── index.ts
└── transport/
    ├── types.ts, index.ts
    └── adapters/
        └── memory/
            └── memory.ts, memory.test.ts, index.ts
```

Each subfolder follows the same `<name>.ts / <name>.test.ts / index.ts` pattern.
The `index.ts` file re-exports the folder's public API — it may also re-export
from deeper subfolders (e.g. `adapters/`).

## Commit messages

Use lowercase, imperative mood, colon prefix for scoping. No period at end.

```
Add conversation listing, deletion, and createdBy filter
Fix cross-conversation interrupt contamination
Update transport README after removing single-conversation server
```

## Release

🚨 **Never do this without explicit user consent.**

1. Update version in `package.json` and move changes from `[Unreleased]` to
   the new version section in `CHANGELOG.md`
2. Commit the version bump: `git commit -m "Release v<VERSION>"`
3. Push: `git push origin main`
4. Create a GitHub release with `gh`:
   `gh release create v<VERSION> --title "v<VERSION>" --notes "<changelog content for that version>"`
