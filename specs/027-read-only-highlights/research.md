# Phase 0 Research: Read-Only Highlights — Position Math Never Writes

Feature 027. Design ground truth: `design/agent-surface-mcp.md`, "Amendment (Sam,
2026-07-21) — reads never write" (commit 6bacaf7).

## R-1 — What exactly writes today, and where

Both public position constructors share the same text-less fallback:

- `createCursorPosition(xmlFragment, blockIndex, charOffset)` — lines 52–77. When
  `findTextNodeAtOffset` returns null (offset past the block's text) it walks to the
  last text node; if the block has **no** text node (`getLastTextNode` returns null)
  it executes lines 68–72:
  ```js
  const newTextNode = new Y.XmlText();
  block.insert(0, [newTextNode]);          // ← DOCUMENT MUTATION
  const relPos = Y.createRelativePositionFromTypeIndex(newTextNode, 0);
  return Y.relativePositionToJSON(relPos);
  ```
- `createCursorPositionFromPath(xmlFragment, path, charOffset)` — lines 580–605.
  Identical fallback at lines 595–599 (`currentElement.insert(0, [newTextNode])`).

`block.insert(...)` / `currentElement.insert(...)` mutate the shared `Y.Doc`, which
(a) produces a persisted update in the update log, (b) advances the doc clock, and
(c) is attributed to the agent's presence session (`origin`). Since the operation is
triggered by `read_document` → `queueHighlightSequence`, a read persists an
agent-authored write. This is the bug.

**All position construction flows through these two functions.** Verified by reading
every helper in the module: `createNodeSelection` (L771) and `createBlockRangeSelection`
(L882) call `createCursorPositionFromPath`; `createExpandingBlockHighlights` (L915)
calls `createCursorPositionFromPath`; `createOperationSelection` (L799) calls
`createCursorPositionFromPath`; `moveCursor`/`findFromCursor` call `createCursorPosition`.
No consumer constructs a `RelativePosition` by mutating the tree itself. Fixing the two
fallback branches therefore fixes every path (read highlights, node selections,
expanding sweeps, operation selections, mutation cursor sweeps) — satisfying FR-001 and
decision D-3 with no per-path flag.

## R-2 — Chosen construction: element-boundary anchor

**Decision**: Replace each `new Y.XmlText(); element.insert(0, [textNode]);
createRelativePositionFromTypeIndex(textNode, 0)` block with:

```js
// element has no text run — anchor at its own boundary, no insertion
const relPos = Y.createRelativePositionFromTypeIndex(currentElement /* or block */, 0);
return Y.relativePositionToJSON(relPos);
```

`Y.createRelativePositionFromTypeIndex(type, index)` accepts any `AbstractType`
(a `Y.XmlElement` qualifies) and, for an empty type at index 0, produces a position
bound to the type itself (`{ type: <element id>, item: null, assoc }`), which travels
and resolves without any content existing inside the element.

**Rationale**:
- Matches the design amendment literally: "the position anchors to the element
  boundary itself; a placeholder text node is never inserted."
- Zero side effects (the invariant, FR-001/FR-003).
- Resolves non-null — see R-3 verification.
- Keeps CRDT identity intact (Principle IV): no node created, so no phantom item,
  no clock advance, relative-position concurrent-edit adjustment preserved.

**Local verification (yjs `^13.6.27`, run 2026-07-21)** — for empty `paragraph`,
`image`, and `horizontalRule` elements inserted into a fragment:

| construction | bytes written | child count after | absPos non-null | absPos.index |
|---|---|---|---|---|
| `createRelativePositionFromTypeIndex(block, 0)` | **0** | **0** (no placeholder) | **true** | 0 |
| `createRelativePositionFromTypeIndex(block, 0, -1)` (assoc −1) | 0 | 0 | true | 0 |
| `createRelativePositionFromTypeIndex(fragment, blockIndex)` (alt) | 0 | 0 | true | 0 |

All three write nothing and resolve via `Y.createAbsolutePositionFromRelativePosition`.
We choose the **element-anchor** form (`type = the element`, `index = 0`), not the
fragment-index form, because it is the true "element boundary" the design specifies and
it degrades gracefully: an offset request into a text-less element clamps to the
element's own start/interior boundary (decision D-4) rather than to a sibling gap in the
parent fragment, which keeps the highlight visually on the block.

### Offset / clamp semantics (D-4)

The text-less branch is reached in two situations: (a) offset 0 into an empty element,
and (b) any offset past the (nonexistent) text of the element. Both now return the same
boundary anchor `createRelativePositionFromTypeIndex(element, 0)`. This mirrors the
existing lenient "clamp to end of last text run" behavior for text-bearing blocks and
honors FR-009 (fail-observational: never throw, never write). No nonzero-offset throw.

## R-3 — Resolver parity (the riskiest correctness point, SC-003/FR-004)

Presence positions are resolved on the **client viewer** by
`client/src/components/CollaborationCursorWithSelection.js`, which wraps y-prosemirror's
`yCursorPlugin` → `relativePositionToAbsolutePosition(yDoc, yXmlFragment, relPos,
ySyncPluginKey.get(state).binding.mapping)`. That resolver maps a Yjs
`RelativePosition` to a ProseMirror absolute position using the ySyncPlugin binding's
type→PM-node mapping. It is **out of scope to change** (FR-007); we must prove the new
shape resolves under it.

- Yjs-level resolution (`createAbsolutePositionFromRelativePosition`) is **confirmed
  non-null** (R-2 table). This is the same primitive `resolveCursorPosition` already
  uses server-side, so server round-tripping is safe.
- y-prosemirror's `relativePositionToAbsolutePosition` first calls
  `createAbsolutePositionFromRelativePosition`; if that is non-null it walks the mapping
  to find the PM position of `absPos.type` and adds `absPos.index`. For an empty
  paragraph/image/hr the element's mapped PM node exists (it renders), so index 0 maps
  inside/at the node boundary. Expected non-null.

**This must not be assumed — it is written as a mandatory test** (see tasks): construct a
live replica (a second `Y.Doc` synced from the first, with a real ProseMirror
`EditorState` + y-prosemirror `ySyncPlugin` binding over the app schema), emit
boundary-anchored positions for each text-less block, and assert
`relativePositionToAbsolutePosition(...)` returns a non-null number for every anchor and
head. If any shape resolves null under the real binding, the plan falls back to the
fragment-index anchor (R-2 row 3) or, last resort, the assoc-tuned form — the test is the
decision procedure. Rejecting a construction that fails parity is cheaper than shipping a
silent SC-003 regression.

**Rejected alternative — skip text-less blocks** (return no position, drop the highlight
step): passes the zero-write test but silently degrades the presence feature. Explicitly
blocked by FR-004/SC-003 and decision D-2. Not chosen.

## R-4 — Deploy-window compatibility (D-1)

No shim. Old-shape positions (referencing a placeholder text node an old server just
created) only exist live during a rolling deploy; presence positions travel over
ephemeral y-websocket awareness and are never persisted, so no stored data ever holds an
old shape. The client resolver already returns null for unresolvable positions and the
viewer skips rendering them — worst case is a transiently skipped highlight step in a
mixed-version session. Accepted as-is (matches D-1). No data migration or backfill.

## R-5 — Latent test dependency audit

`server/mcp/__tests__/yjs/cursor-operations-empty-blocks.test.js` **explicitly asserts
the buggy behavior**: after `createCursorPosition` on an empty block it checks
`children.length === 1` and `children[0] instanceof Y.XmlText` (six tests, e.g. lines
41–43, 66–73, 124–129, 182–187). These assertions encode the placeholder insertion and
MUST be honestly re-pinned to the new invariant (no child created; position resolves at
the boundary), not deleted — per the plan's "audit and re-pin honestly" directive and
SC-006 ("passes unchanged except where it asserted the old buggy behavior").

Other cursor/highlight tests (`cursor-operations-hierarchy.test.js`,
`tools/read-document.test.js`, `xpath-highlight.test.js`, `mutation-aggregator.test.js`)
operate on text-bearing content and should pass unchanged; the byte-identical text-path
guard (FR-005) protects them. The implementer must run the full presence/highlight suite
and treat any *other* failure as a real regression to investigate, not to silence.

## R-6 — Test harness constraints

Backend tests are serial-only against a shared DB (Constitution II; MEMORY:
backend-test-db-serial-only). The implementer runs in a worktree with a dedicated DB
`collab_test_db_027`; jest config ignores `/.claude/worktrees/`, so a temp jest config or
`rootDir` override plus `--forceExit` is needed (MEMORY: local-backend-test-stack,
ci-reindexStale-shared-db-flakiness). The zero-writes integration test must assert
against the persisted update-log row count + doc clock + version-history author set
(surfaces already exist per spec Assumptions — `getRecentUpdatesWithUsers`,
`versionHistory.getCurrentSessionAuthors`), requiring no new observability.

## Decisions summary

| # | Decision | Rationale |
|---|---|---|
| R-2 | Element-boundary anchor `createRelativePositionFromTypeIndex(element, 0)` | Literal design match; zero writes; resolves non-null; CRDT-safe |
| R-2/D-4 | Any offset into a text-less element clamps to the boundary anchor | Mirrors existing clamp-to-end; fail-observational (FR-009) |
| R-3 | y-prosemirror resolver parity proven by live-replica test, not assumed | Riskiest correctness point (SC-003); test is the fallback decision procedure |
| R-4/D-1 | No deploy-window shim | Positions ephemeral; worst case a transient skipped step |
| R-5 | Re-pin `cursor-operations-empty-blocks.test.js`, don't delete | Honest test hygiene; SC-006 |
| — | Fix the two shared fallback branches only | All construction routes through them; covers all paths (D-3) |
