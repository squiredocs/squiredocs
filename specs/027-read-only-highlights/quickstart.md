# Quickstart / Validation: Read-Only Highlights

Server-only change in `server/mcp/yjs/cursor-operations.js`. Backend tests are
**serial-only** against a shared DB; in a worktree use a dedicated DB
`collab_test_db_027` with a temp jest config / `rootDir` override plus `--forceExit`
(jest config ignores `/.claude/worktrees/`).

## Prerequisites

- Run inside the Minikube `app-dev` pod (see `docs/dev.md`); or the local backend test
  stack (pg+pgvector+redis + env) per MEMORY `local-backend-test-stack`.
- Node 22+, `yjs ^13.6.27` (server), `y-prosemirror ^1.2.0` available for the
  resolver-parity test.

## Reproduce the bug (before the fix)

Unit-level, no DB needed:

```bash
node -e '
const Y=require("yjs");
const doc=new Y.Doc(); const frag=doc.get("default",Y.XmlFragment);
frag.insert(0,[new Y.XmlElement("paragraph")]);            // empty, text-less
const before=Y.encodeStateAsUpdate(doc).length;
require("./server/mcp/yjs/cursor-operations").createCursorPosition(frag,0,0);
const after=Y.encodeStateAsUpdate(doc).length;
console.log("bytes written by a READ position:", after-before, "child count:", frag.get(0).toArray().length);
'
```

Today this prints a nonzero byte delta and child count 1 (a placeholder `Y.XmlText`
was inserted). After the fix it MUST print `0` and child count `0`.

## Validate the fix

1. **Unit — boundary anchor is pure and resolvable** (`cursor-operations-boundary.test.js`):
   for empty paragraph / image / horizontalRule / nested empty container / empty
   document, assert `createCursorPosition` and `createCursorPositionFromPath` write zero
   bytes, create no child, and their output resolves non-null via
   `Y.createAbsolutePositionFromRelativePosition`.

2. **Unit — text-path regression** (`cursor-operations-textpath-regression.test.js`):
   on a corpus of text-bearing blocks, assert the serialized position JSON is
   byte-identical to a checked-in snapshot (FR-005/SC-004). Snapshot must be captured
   from the current/old code path for text-bearing inputs.

3. **Unit — resolver parity** (`cursor-operations-resolver-parity.test.js`): on a live
   replica with a real ProseMirror `EditorState` + y-prosemirror `ySyncPlugin` binding
   over the app schema, assert every boundary-anchored anchor/head resolves non-null
   through y-prosemirror `relativePositionToAbsolutePosition`. **This is the go/no-go for
   the chosen construction** — if it fails, switch to the fragment-index anchor per
   research R-3.

4. **Re-pin latent test** (`cursor-operations-empty-blocks.test.js`): the six tests
   asserting `children[0] instanceof Y.XmlText` after a position call are rewritten to
   assert **no** child is created and the position resolves at the boundary. Do not
   delete assertions.

5. **Integration — reads leave zero trace** (`integration/read-zero-writes.test.js`,
   P1 acceptance / SC-001/SC-002): build a doc with an empty paragraph + image + hr (and
   separately an empty doc); record update-log row count, doc clock, and version-history
   author set; perform a whole-document read AND an xpath read targeting each text-less
   block; assert row count unchanged, clock unchanged, no new agent author. Runs against
   `collab_test_db_027`.

6. **Integration — pure mutation sweeps** (SC-005): mutate two paragraphs around an
   image so the sweep crosses the image; assert the persisted update set equals the
   mutation's intended paragraph edits (no image-block insertion) while sweep coverage is
   present.

7. **Full presence/highlight suite** (SC-006): run the existing suites
   (`cursor-operations-hierarchy`, `mutation-aggregator`, `tools/read-document`,
   `xpath-highlight`, `agent-presence`); everything passes unchanged except the re-pinned
   empty-blocks file.

## Run

```bash
# from the worktree, with SPECIFY/DB env set for 027
npx jest server/mcp/__tests__/yjs server/mcp/__tests__/integration/read-zero-writes \
  server/__tests__/xpath-highlight --runInBand --forceExit
```

## Expected outcome

Zero persisted updates from any read; agent never appears as author of a doc it only
read; every text-less block in a sweep gets a resolvable, visible highlight; text-bearing
positions byte-identical to before; mutation writes unchanged.
