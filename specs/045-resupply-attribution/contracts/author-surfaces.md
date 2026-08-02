# Contract — author surfaces consume one resolution (FR-001, FR-003..FR-007)

## The single accumulation helper

`server/version-history.js` gains one private helper. It REPLACES the currently duplicated
author-accumulation blocks in `groupUpdatesIntoVersions` and `computeRangeMeta` (041 already
requires those two to stay identical; this makes it structural):

```js
function collectAuthorsForUpdate(update, authors /* Map */, ctx = EMPTY_RESOLUTION) {
  const outcome = update.viaSync === true ? ctx.outcomes.get(update.clock) : undefined;

  if (!outcome) {
    // Pre-045 behavior, byte-for-byte: direct rows, and via_sync rows in any caller
    // that passes no context (nothing in production does after this feature).
    ...existing createAuthor / UNKNOWN_AUTHOR_KEY logic...
    return;
  }

  for (const origin of outcome.origins) {
    const author = authorFromOrigin(origin, ctx.directory);   // createAuthor shape
    if (!author) { authors.set(UNKNOWN_AUTHOR_KEY, UNKNOWN_AUTHOR); continue; } // deleted account
    const key = getAuthorKey(origin.userId, origin.agentName);
    if (!authors.has(key)) authors.set(key, author);
  }
  if (outcome.unresolved && !authors.has(SYNCED_CONTRIBUTION_KEY)) {
    authors.set(SYNCED_CONTRIBUTION_KEY, SYNCED_CONTRIBUTION);
  }
}
```

Invariants:

- The stamped `userId`/`agentName` of a `via_sync` row with an outcome is **never** read.
- `createAuthor`'s shape, `getAuthorKey`'s keying, the `UNKNOWN_AUTHOR` collapse and
  `dedupeOnBehalfOf` are unchanged — a resolved origin is displayed exactly like a direct
  author (FR-003).
- `onBehalfOf` provenance keeps coming from the ROW (it is transport provenance about the
  push that carried it), not from the resolution.
- Deletion-only and unresolvable rows contribute exactly ONE `SYNCED_CONTRIBUTION` entry per
  version, no matter how many rows or origins were unresolvable (FR-004/FR-005).

## Threading (no surface computes its own resolution)

| Function | Change |
|---|---|
| `groupUpdatesIntoVersions(updates, threshold, { resolution } = {})` | additive options arg; delegates to the helper |
| `computeRangeMeta(updates, clockStart, clockEnd, { resolution } = {})` | additive options arg; delegates to the helper |
| `computeFragmentMeta(updates, clockStart, clockEnd, { resolution } = {})` | passes through |
| `mergeNamedVersions(auto, named, updates, { resolution } = {})` | passes through to both `computeRangeMeta` and `computeFragmentMeta` |
| `getVersionTimeline(persistence, docGuid)` | resolves ONCE over the full row set, threads it into grouping and merging |
| `getUpdatesForVersion(persistence, docGuid, cs, ce, limit)` | resolves over the range rows; **the row projection at this call site must carry `viaSync` through** (it currently drops it) |
| `getCurrentSessionAuthors(updates, { resolution } = {})` | stays SYNCHRONOUS; the caller resolves and passes the context |
| `getContentAtClock(persistence, docGuid, clock)` | resolves the single row; single-slot rule below |

Omitting the option always yields exactly today's behavior, so every existing test that calls
these helpers directly stays valid and the pre-045 baseline is one argument away.

## Single-slot surfaces (RBD-045-9)

`getContentAtClock().author` and `read-document`'s `lastModifiedBy` display ONE author:

| Outcome | Displayed |
|---|---|
| not a `via_sync` row | unchanged (`createAuthor(row) || UNKNOWN_AUTHOR`) |
| exactly one origin, `unresolved: false` | that author (or `UNKNOWN_AUTHOR` if the account is gone) |
| multi-origin, or `unresolved: true` | `SYNCED_CONTRIBUTION` |

The resolution is identical to the timeline's; only the arity of the rendering differs
(FR-007 is about the outcome, not the layout).

## MCP recent authors (`server/mcp/tools/read-document.js`)

```js
const ctx = await resolveForRows(persistenceProvider, docGuid, recentUpdates);
lastModifiedBy = authorForSingleSlot(lastUpdate, ctx);            // RBD-045-12
recentAuthors  = versionHistory.getCurrentSessionAuthors(recentUpdates, { resolution: ctx });
```

`recentAuthors` may therefore contain `SYNCED_CONTRIBUTION`. The field stays an array of the
same author shape, so the tool's response schema is unchanged (additive `isSynced` only).

## Client rendering (FR-004 / RBD-045-2)

- `client/src/components/HierarchicalVersionList.jsx` (`AuthorList`): when `author.isSynced`,
  render the dot in a distinct style (outlined, not filled) and set a `title` explaining the
  state ("This content arrived through a collaborator's reconnect. Its original author could
  not be determined."). Name text renders as-is.
- `client/src/components/HierarchicalVersionList.css`: the outlined-dot rule, light and dark.
- `VersionPreview.jsx` needs no change (it renders `name`/`color` and already handles a null
  `id`).
- No client-side authorship logic is added. The client never reads `via_sync`.

## What must NOT change (FR-010)

`restoreVersion`, `getVersionContent`, `server/undo/**` (including the `viaSync` run-breaking
guard at `legacy.js:62`), `server/diff-service.js`, the MCP conflict guard's
`foreignEditsSince`/`isSameIdentity` staleness checks, permissions, and persistence
attribution never receive or consult a resolution context. Enforced by an import test.
