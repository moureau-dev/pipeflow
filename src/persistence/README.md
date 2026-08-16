# Persistence

Storage contract for the conversation domain, plus built-in adapters.

```text
persistence/
├── persistence.ts          the Persistence interface
├── contract-tests.ts       shared behavioral tests every adapter must pass
└── adapters/
    ├── memory/             in-memory (tests, development)
    └── sqlite/             bun:sqlite-backed (local deployments)
```

## Interface

The `Persistence` contract covers:

- **Conversations** — create, get, list, finalize (end time), delete.
- **Participants** — add and list per conversation.
- **Transcript** — append (upsert) and list entries.
- **Turns** — append and list.
- **Generations** — upsert and list. `appendGeneration` upserts by id so
  status updates (streaming → completed/cancelled) overwrite, and generation
  records carry `kind`/`parentGenerationId` for delegated sub-generations.

## Contract tests

`contract-tests.ts` runs the same behavioral suite against every adapter, so
new storage backends (Postgres, Redis, …) are verified consistent with the
built-ins before they ship.

## Usage

```ts
import { MemoryPersistence, SQLitePersistence } from "@moureau/pipeflow/persistence";

const pipeflow = new Pipeflow({
  persistence: new SQLitePersistence({ filename: "./pipeflow.db" }),
});
```

See the root [README](../../README.md) for the public API.
