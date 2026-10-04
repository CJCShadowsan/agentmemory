# Local patches

This fork tracks [upstream](https://github.com/rohitg00/agentmemory) and adds
the patches below on top of it. `main` is kept in sync with `upstream/main`;
patches live on their own branches so they can be rebased or upstreamed
independently.

## `patch/autonomous-distill`

Adds `POST /agentmemory/distill-graph-to-memory`, which distills the knowledge
graph into long-term memory artifacts.

### What it does

Takes the highest-degree graph nodes (those referenced by at least
`minDegree` observations) and asks the configured provider for three kinds of
artifact:

- **insights** — durable claims about this codebase or workflow,
- **lessons** — imperative rules general enough to apply to future sessions,
- **crystals** — reusable multi-step procedures and what they achieved.

### Merge, don't duplicate

Every artifact is keyed by `fingerprintId` over its lowercased content, and
lessons are written through `mem::lesson-save`. Re-running distillation on an
unchanged graph therefore *reinforces* existing skills — bumping
`reinforcements` and `confidence` — instead of writing near-duplicates. This is
what lets a learning loop run on a timer without bloating the store.

### Request

```
POST /agentmemory/distill-graph-to-memory
{ "scope": "all" | "insights" | "lessons" | "crystals",
  "limit": 50,        // 1..500, default 50
  "minDegree": 2,     // default 2
  "project": "..." }  // optional
```

Response carries `insightsAdded` / `insightsReinforced`,
`lessonsAdded` / `lessonsStrengthened`, `crystalsAdded` /
`crystalsReinforced`, and `nodesConsidered`.

### Files touched

| File | Change |
| --- | --- |
| `src/functions/distill.ts` | New: the distillation function, prompt, and XML parser |
| `src/index.ts` | Registers `mem::distill-graph-to-memory` |
| `src/triggers/api.ts` | Registers `api::distill-graph-to-memory` and its HTTP route |
| `src/functions/reflect.ts` | Exports `reinforceInsight` for reuse |
| `src/types.ts` | Adds `"graph-distillation"` to `Lesson["source"]`, `"distill"` to the audit operation union |
| `src/functions/lessons.ts` | Widens the `mem::lesson-save` payload's `source` union |
| `README.md`, `AGENTS.md` | Endpoint count 138 → 139 |

### Note on bundled workers

The published package ships a split worker bundle. A patch applied to only one
half of that split will 404 at runtime even though it typechecks and builds —
verify against whichever file the engine actually loads. This branch patches the
TypeScript source instead, so every bundle produced by `npm run build` carries
it.

## Keeping in sync with upstream

```bash
git fetch upstream
git rebase upstream/main patch/autonomous-distill
npm run build && npm test
```

## Build notes

`npm install` needs `--legacy-peer-deps` on npm 10 (arborist throws
`Cannot read properties of null (reading 'edgesOut')` resolving the vitest 4
peer set). The rolldown native binding is an optional dependency, so a
`--omit=optional` install needs it added explicitly to build.