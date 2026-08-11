# Research — 054 Sync Feedback Hardening (Repo-Sync Trust Pack)

**Phase 0 output.** Every decision below is grounded in the code as it stands on `main`
(2026-08-11). Line numbers are anchors, not contracts — re-verify before editing.

> `server/markdown-sync.js` contains NUL bytes. A plain `grep` reports it as binary and
> "finds nothing". Use `grep -a` or read the file directly. This has misled three agents.

---

## R1 — The staleness signal is already computed; nothing in the engine needs to change

**Finding**: `validateSyncBaseline` (`server/markdown-sync.js:1020`) reads the live clock at
:1034 and **already returns it on the success path** (:1042 —
`return { baselineClock, flavor, currentClock }`). The spec's phrasing ("computes
currentClock and discards it") describes the *caller*: `handleSyncPush`
(`server/api/docs-import.js:104-116`) destructures only `const { baselineClock, flavor } = v;`
and drops `currentClock` on the floor. On the rejection path the route already forwards it
(:113).

**Decision**: Compute the staleness block **in the route**, from the value validation already
returns, and merge it into whatever receipt `applySyncPush` returns. The engine's three
receipt exits (noop :1103, idempotent-noop :1128, applied :1180) are left alone.

**Rationale**: One construction site instead of three; FR-001 automatically covers "applied,
noop, and overlap cases alike" (acceptance scenario 5) because the merge happens after the
engine returns. It also satisfies FR-001's definition of `currentClock` exactly — *the doc's
clock at validation time* — rather than the re-export clock the engine reads at :1101/:1177,
which is a different (later) number.

**Alternatives rejected**: Threading `currentClock` into `applySyncPush` and stamping each of
the three exits — three places to forget, and the engine would have to carry a value it has
no use for. Re-reading the clock inside the engine — would report a *later* clock than the
one strictness was judged against, so a strict push could pass validation and then report
`docChangedSinceBaseline: true`.

**Consequence**: `strict` is evaluated in the route too, immediately after validation and
before the presence session opens (`docs-import.js:126-127`) — so FR-004's "document, history
and viewers MUST be untouched" is structural, not a promise.

## R2 — Dry run cuts between overlap detection and `storeUpdate`

**Finding**: `applySyncPush` (:1063) is genuinely compute-then-mutate, as the spec claims.
The ordered sequence is:

| Step | Line | Mutates the live doc? |
|---|---|---|
| `buildBaseline` → fork + sourceMap | 1088 | No (detached `Y.Doc` fork) |
| `resolveImageRefs` + `canonicalizePushedStaged` | 1095-1097 | No doc mutation — **but see R3** |
| noop short-circuit | 1100-1108 | No |
| `computeHunks` → `planPush` → `applyHunks` | 1113-1118 | No — mutates the **fork** only |
| `pushIsAlreadyApplied` short-circuit | 1125-1133 | No |
| `detectOverlaps` | 1141-1148 | No |
| **`persistence.storeUpdate`** | **1160** | **Yes — first durable mutation** |
| `applyLiveUpdate` (fan-out) | 1170 | Yes (broadcast) |
| `searchIndexer.markDirty` | 1173 | Yes (index) |

**Decision**: `applySyncPush` gains a `dryRun` option. When set, it returns the dry-run plan
immediately after the overlaps block (between :1148 and :1160). Both noop short-circuits
return their existing receipts with the dry-run marker added and the `markdown` re-export
retained (it is a read).

**Rationale**: The cut point is exactly the first durable write, so "no stored update, no
version entry, no clock advance" (FR-006) is enforced by control flow rather than by a set of
suppression flags. `fork.destroy()` in the `finally` (:1184) already reclaims the fork.

**Alternatives rejected**: A separate `planSyncPush` entry point duplicating the first half of
`applySyncPush` — two code paths that must stay in lockstep is precisely how a preview starts
lying. A transaction-and-rollback — `storeUpdate` fan-out and the search index are not
transactional.

**Presence**: FR-007/RBD-054-3 forbid a presence session. That is also route-level: skip
`importPresence.observeSyncRange`/`settle` (`docs-import.js:127`, :163-176) and — critically —
skip opening the session *upstream* of `handleSyncPush`, where the sync route creates it.

## R3 — Dry run and the staged image pass (new decision → RBD-054-11)

**Finding**: `canonicalizePushedStaged` (:338) runs `stageImagePass`
(`server/markdown-import.js:150`), which performs two **durable, non-document** side effects:
`externalImagePass` fetches external `http(s)` images and rehosts the bytes to S3, and
`reconcileCrossDocImages` copies cross-document images onto the target doc. Both run at
:1096 — *before* the dry-run cut point of R2.

This is a real gap in FR-006's "nothing applied". It is not doc mutation, not a stored update,
not a version entry, and not a clock advance — the four things FR-006 and SC-003 actually
enumerate and measure — but it is not nothing either.

**Decision (RBD-054-11, recorded in the ledger)**: the dry run runs the **same** staged image
pass as a real push, and the contract discloses it. Rationale: the staged pass is what
produces the canonical pushed string that the diff is computed from; skipping it would make
the dry run diff a *different* string than the real push (unvetted `data:` srcs present,
external srcs un-degraded), so the preview would predict the wrong plan — the one outcome
RBD-054-2 rules out. The effects are storage-side, idempotent in practice, and invisible in
the document, its history, and its viewers.

**Alternative rejected**: `canonicalizePushed` (the non-staged sibling, :310) for dry runs.
Cheaper and side-effect-free, but it makes the dry-run plan structurally unable to predict the
real push for any document containing images.

## R4 — `pushTouchedBlocks` cannot be reused as-is for the change report

**Finding**: `pushTouchedBlocks` (:862) maps `plan.reconcileBlocks` to the label `'text'`
(:867) — reconcile and plain-text edits are deliberately conflated. Its only consumer is
`defaultDetectOverlaps` (:898), where the result becomes the **`pushSide` field of every
overlap flag** — a shipped contract (`specs/004-two-way-sync/contracts/sync-push.md`:
"`pushSide` ∈ `text|structural|deleted`"), pinned in
`server/__tests__/markdown-sync.overlap.test.js`.

FR-009 requires `reconcile` as a *distinct* op kind. Changing `pushTouchedBlocks` to emit it
would silently re-label existing overlap flags.

**Decision**: Add a sibling function `buildChangeReport(plan, sourceMap, canonicalMd)`.
`pushTouchedBlocks` is **not modified**. The overlaps contract is unchanged.

**Rationale**: The two consumers answer different questions. `pushSide` answers "did our push
touch a block the doc also changed" (intersection semantics, where reconcile and text behave
identically). `blocksChanged` answers "what did we do to each block" (reporting semantics,
where the distinction is the whole point). One function serving both would have to be
parameterized on its own output vocabulary.

## R5 — Structural insertions have no baseline block; the report needs an anchor

**Finding**: `planPush` (:524) pushes hunks with `blocks: []` for pure boundary insertions
(:556, and `classifyRange` yielding no blocks). `structuralOps` (:703) already resolves this:
`touched.length === 0` → an `insertions` entry anchored on the **preceding** block
(`afterBlock`, :715-719); everything else becomes a `replacements` entry spanning
`first..last` baseline block indices (:726-735), with adjacent groups coalesced (:729).

**Decision**: `buildChangeReport` calls `structuralOps` — the same function `applyHunks` uses
(:747) — so the report describes exactly the operations that would be applied. Report shape:

- each `replacements` group → one entry per baseline block in `first..last`, kind
  `structural`;
- each `insertions` entry → one entry with kind `structural`, `blockIndex` of the anchor
  block, and an explicit `position: 'after'` (or `'start'` when `afterBlock` is null),
  because an inserted block has no baseline index of its own;
- each `plan.textBlocks` block → kind `text`;
- each `plan.reconcileBlocks` block → kind `reconcile`.

**Rationale**: Reusing `structuralOps` means the report cannot drift from application —
including the coalescing rule, which would otherwise over-report. FR-009's acceptance
scenario 2 ("the affected *positions* appear") is satisfied for insertions by the anchor +
position pair rather than by inventing a post-push index the baseline source map cannot know.

**055 interface note**: `buildChangeReport` depends only on `plan.{textBlocks,
reconcileBlocks, structural}` and `structuralOps` — the same surface `applyHunks` consumes.
Feature 055 changes how that plan is *computed* (`computeHunks` gains a block-alignment
pre-pass); the plan's shape is what 054 reads. If 055 alters the plan's shape, the report
follows for free; 054 must not touch `computeHunks` or the alignment (spec Out of Scope).

## R6 — Excerpt: one helper, raised to 120 chars (amends RBD-054-6)

**Finding**: `blockExcerpt` (:838) already exists — `md.replace(/\s+/g, ' ').trim().slice(0,
80)` — and produces the `excerpt` on overlap flags. No test pins its length; the only
assertion is a loose `toContain('Bravo')` (`markdown-sync.overlap.test.js:58`).

**Decision**: Reuse the **same** helper for `blocksChanged`, raising its cap to 120 with an
ellipsis marker on truncation (RBD-054-6's shape). Both block lists in a single receipt then
carry identically-shaped excerpts.

**Rationale**: A receipt with two block lists whose excerpts truncate at different lengths is
a needless inconsistency. Raising to 120 is non-breaking (no pinned length) and is what
RBD-054-6 asked for; the ledger entry is amended to record that overlap excerpts widen too.

**Bound check**: a 500-block replace-heavy push yields 500 × (≤120 chars + ~60 bytes of JSON
scaffolding) ≈ 90 KB worst case — within FR-010's "receipts stay bounded", no pagination.

## R7 — Ordered-list `start`: four edits that MUST land together

**Finding**: the four sites are exactly as the spec says, and the model already carries the
attribute end to end:

| Site | Line | Current | Needed |
|---|---|---|---|
| `toMarkdown` | `server/mcp/yjs/serialization.js:255-262` | `let num = 1;` | seed from `start` |
| `toMarkdownWithSourceMap` | `server/mcp/yjs/serialization.js:646-653` | `let num = 1;` | identical change |
| strict parser | `shared/markdown/strict-parser.js:240` | `attrs: { start: 1 }` | first item's number |
| tolerant parser | `shared/markdown/tolerant/block-parser.js:442` | `attrs: { start: first.start }` | **already correct** |

The ProseMirror schema already declares it: `orderedList: { attrs: { start: { default: 1 } } }`
(`shared/prosemirror-schema.js:62-63`), with `parseDOM` coercing via `+dom.getAttribute(...)`.

**Decision**: Both serializer copies read `node.getAttribute('start')` and coerce with
`Number(...)`, falling back to 1 when the value is absent, non-finite, or `< 1` (RBD-054-8).
The two copies must remain textually parallel — `serialization.sourcemap.test.js` and
`format-roundtrip.test.js:764` pin their byte-identity (SC-006).

**Coercion matters**: the attribute reaches a `Y.XmlElement` as a *number* from the tolerant
parser and could arrive as a *string* from JSON-shaped block appends — the same dual-typing
the adjacent `taskItem` code already handles explicitly (`checked === true || checked ===
'true'`, :268). `Number()` + `Number.isFinite` covers both.

**Why together**: the diff engine serializes a version to markdown and re-parses it with the
**strict** parser (R8). Landing FR-012 without FR-013 makes the serializer emit `11.` and the
parser read it back as `start: 1` — every ordered-list item would then diff as changed on
every version comparison. These are one atomic change, not two.

## R8 — FR-013 touches a *frozen* parser: three consequences the spec does not name

**Finding**: `shared/markdown/strict-parser.js` is explicitly frozen —
"FROZEN (feature 001, CN-2): this is the byte-identical pre-feature parser, used by the diff
engine via `{ strict: true }`. Do NOT 'improve' it" (:12-16). Three consequences:

1. **The sync path does not use it.** `markdownToPm` defaults to `{ strict = false }`
   (`shared/markdown/index.js:46`), and `canonicalizePushed`/`canonicalizePushedStaged` call
   it with no options (:311, :339) — the sync path runs the **tolerant** parser, which
   already preserves `start`. The spec's acceptance scenario US4-3 calls the strict parser
   "(sync path)"; that parenthetical is inaccurate. The change is still required — the
   registry round-trip suite runs `describe.each([false, true])` over both parser modes
   (`format-roundtrip.test.js:41`), so strict mode must round-trip `11.` too (FR-014).
   The real consumers are `server/diff-service.js:316-323` and
   `server/diff/apply-word-marks.js:35`.

2. **One pinned test asserts today's behavior and will fail by design.**
   `server/__tests__/markdown-tolerant.test.js:203`:
   `expect(markdownToPm('3. third', null, { strict: true }).content[0].attrs.start).toBe(1);`
   — inside a test literally named *"ordered list honors start number; strict fixes start at
   1"*. This test must be updated (both modes now preserve `start`), not deleted.

3. **The characterization snapshot survives untouched.** All 70 cases in
   `server/__tests__/fixtures/markdown/strict-characterization.json` were checked: the two
   containing an `orderedList` (`block-orderedlist` from `1. first`, and
   `fragment-partial-ordered` from `1. first\n2. second`) both expect `start: 1`, which the
   new behavior also produces. The CN-2 byte-identity pin stays green with no fixture
   regeneration.

**Decision on the freeze**: proceed. The freeze exists to stop *grammar* drift in the diff
engine; this is a ratified design amendment that both parsers must honor for the round-trip
invariant to hold in both modes. The strict parser's header comment is updated to record the
one sanctioned exception with its authority (design amendment 2026-08-11, FR-013).

## R9 — The diff cache must be invalidated (new decision → RBD-054-12)

**Finding**: `server/diff-service.js:35` — `const CACHE_VERSION = 'v10'`, keying every Redis
diff entry (:64). The strict parser feeds that engine (R8). After FR-013, a diff over a
document containing an ordered list starting at 11 renders differently than the cached entry
computed before it, and cached entries are read for the life of the key.

**Decision (RBD-054-12, recorded in the ledger)**: bump `CACHE_VERSION` `v10` → `v11` in the
same change. Two pins must move with it: `server/__tests__/diff-service.test.js:992-993`
("CW-T6: CACHE_VERSION is v10 and a v9 entry is never read") and
`server/__tests__/markdown-strict-characterization.test.js:77`.

**Rationale**: This is the established convention in this repo — the same bump was taken for
feature 022's two-tier word diff (v7→v8) and for the tail-gap/parity cut (v9→v10). Serving a
stale diff whose list numbering contradicts the document is precisely the class of quiet
wrongness the version-history campaign spent 038-049 removing.

## R10 — Boolean query params: follow the route's own convention

**Finding**: `parseReceiptOptions` (`server/api/docs-import.js:242-260`) is the route's
existing boolean convention: `'true'`/`'1'` → true, `'false'`/`'0'` → false, anything else →
`{ error }` → HTTP 400 with `Unsupported <name> value: <v>. Accepted values: true, false, 1, 0`.

**Decision**: `strict` and `dryRun` parse through a shared helper extracted from that exact
logic, producing the same message shape (RBD-054-9). `dryRun` on a non-sync mode or the
create route is a 400 naming the supported combination (RBD-054-4).

**Rationale**: Route-internal consistency; `strict=yes` failing loudly is the whole point of
FR-004's fail-closed posture.

## R11 — Test placement

Existing suites map cleanly onto the five stories; no new test architecture is needed.

| Concern | Suite |
|---|---|
| Staleness fields, strict 409, param validation, dryRun end-to-end | `__tests__/integration/sync-push.route.test.js` |
| Rejection precedence (`sync_baseline_missing` before staleness) | `server/__tests__/markdown-sync.rejection.test.js` |
| `buildChangeReport` unit behavior (text/reconcile/structural/insert) | `server/__tests__/markdown-sync.overlap.test.js` (block-report neighbors) |
| Dry-run no-trace (clock, rows, viewers) | `__tests__/integration/docs-import-concurrency.test.js` neighbors / route suite |
| Ordered-list round trip, both flavors, both parser modes | `server/__tests__/format-roundtrip.test.js` corpus (:1015-1025) |
| Both-serializer byte-identity | `server/__tests__/serialization.sourcemap.test.js` + `format-roundtrip.test.js:764` |
| Strict-parser start preservation | `server/__tests__/markdown-tolerant.test.js:200-204` (update in place) |
| Guidance-surface budgets and phrases | `server/mcp/__tests__/tools/trigger-surfaces.test.js` |

Per Constitution II, backend suites run parallel with per-worker DB isolation; the round-trip
corpus is pure in-memory Yjs and needs no database.
