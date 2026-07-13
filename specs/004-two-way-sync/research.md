# Research: Two-Way Sync (Offline-Collaborator Push)

**Feature**: 004-two-way-sync | **Date**: 2026-07-13

All findings below are grounded in the current codebase (files cited inline) and the design doc
`design/markdown-import-two-way-sync.md` §2.4/§2.4.1. Format: Decision / Rationale / Alternatives.

---

## R1. Serializer source map: how `toMarkdownNodes` emits runs, and the map design

### How the serializer emits output today (read of `server/mcp/yjs/serialization.js`)

`toMarkdownNodes(nodes)` walks the Yjs tree pushing string fragments onto a shared `parts` array:

- **Text runs**: `renderInline(textNode)` iterates `textNode.toDelta()`. Each delta op is a string
  `op.insert` plus `op.attributes`. The op's text is wrapped outward by registry marks
  (`INLINE_MARKS` order: code, bold, italic, strike, then HTML-tag marks, then textStyle span,
  then link). Crucially, **the plain text characters of each delta op appear contiguously in the
  output**, surrounded by syntax (`**`, `` ` ``, `<u>…</u>`, `[…](url)`).
- **Block syntax**: heading markers (`#{n} `), fence lines (```` ```lang ````), list markers
  (`- `, `1. `, indentation), blockquote prefixes (`> `), table pipes and separator rows,
  `---` for horizontalRule, `![alt](src)` for images — all emitted as literals with no text node
  behind them (image alt/src come from *attributes*, not Y.XmlText).
- **Assembly**: each top-level node renders into `parts`, is joined, right-trimmed of `\n`, and
  blocks are joined with `\n\n`; a final `.replace(/\n{3,}/g,'\n\n').trim()` normalizes.

Two wrinkles matter for offset accounting:

1. **Blockquote splice trick**: children render into the shared `parts`, get spliced out, and are
   re-pushed with `'> '` prefixes. A source map built on "global offset at time of push" would be
   invalidated by this splice. The map must therefore be built on the **final assembled string**,
   not on push-time offsets.
2. **Final trim/normalize**: the trailing `replace`/`trim` shift offsets. Same conclusion.

### Decision: two-pass emit — record *runs* during the walk, resolve offsets during assembly

Add `toMarkdownWithSourceMap(nodes)` (new export; `toMarkdown`/`toMarkdownNodes` unchanged and
byte-identical). Internally the walker pushes, instead of bare strings, tagged segments:

```js
{ s: '**bold text**', runs: [{ start: 2, end: 11, node: <Y.XmlText ref>, off: 17 }] }
// start/end are offsets WITHIN this segment's string; off = offset of the run's first char
// within the Y.XmlText's plain text (delta text, marks excluded)
```

- `renderInline` knows, per delta op, exactly which slice of its returned string is the op's
  literal text (everything else is mark syntax); it emits one run per delta op, tracking a running
  plain-text offset within the Y.XmlText.
- Block-syntax pushes carry `runs: []` — they are **structure**.
- Assembly walks the segment list exactly as today (same joins, same blockquote splice — splicing
  segments preserves their internal runs), computing each segment's final absolute offset, then
  flattens runs into a sorted array:

```js
sourceMap = {
  runs: [ { mdStart, mdEnd, textNode, textOff } ... ],   // sorted by mdStart, non-overlapping
  blocks: [ { mdStart, mdEnd, blockIndex, blockNode } ... ] // top-level block extents incl. syntax
}
```

`blocks` is derived for free: the per-top-level-node render loop already knows each block's final
string extent (post-join, pre-final-normalize; the final `\n{3,}` collapse and `trim()` are applied
segment-consistently by doing the normalize on the segment list before flattening, or —
simpler and chosen here — by making the with-source-map path build blocks joined by exactly
`\n\n` and trimmed per block, so the final normalize is a no-op by construction; a debug
assertion checks `assembled === toMarkdownNodes(nodes)`).

**Caveat carried into implementation**: `getChildText` (used for headings, list items, table
cells) flattens child text without per-op boundaries. The with-map variant must thread run
recording through `getChildText` as well; mechanical but required for text hunks inside headings,
list items, and table cells. Table cells additionally escape `|` → `\|` — an escaped character
is *syntax over text* (2 md chars ↦ 1 text char), so runs must split around it (the `\` maps to
structure, the `|` maps to text). Same treatment for any future escapes.

**Rationale**: builds the map inside the one serializer that owns the grammar (the design doc's
point: this is what an off-the-shelf library could not provide); zero change to existing output;
run-per-delta-op granularity is exactly the CRDT-relevant granularity (a delta op is a maximal
same-marks text span).

**Alternatives considered**:
- *Post-hoc alignment* (serialize, then re-find text in output by string search): rejected —
  ambiguous for repeated substrings, breaks on escaping, and duplicates grammar knowledge.
- *Character-by-character map array* (one entry per md char): rejected — O(doc) memory blowup
  with no added power; ranges suffice because runs are contiguous.
- *Making `toMarkdownNodes` always produce the map*: rejected — hot paths (diff-service, MCP
  read_document) don't need it; keep the fast path allocation-free.

## R2. Markdown offset → Y.XmlText offset: the mapping function

### Decision

`resolveMd(offset)` binary-searches `sourceMap.runs`:

- Inside a run → `{ kind: 'text', textNode, textOff: run.textOff + (offset - run.mdStart) }`.
- Not inside any run → `{ kind: 'syntax', block }` (locate via `sourceMap.blocks`).
- A *range* [a,b) is a **text range** iff every char in [a,b) lies within runs of **one single
  block**, and all touched runs belong to the same Y.XmlText **or** to sibling text nodes of the
  same block in document order (an inline-content block's children). Insertion points (a===b) at a
  run boundary resolve to text if both neighbors are runs of the same block (prefer the left run's
  node/offset — appending to the preceding styled span matches typing behavior and Yjs
  `insert(idx)` semantics where inserted text inherits attribution by position, not marks).

Character positions consumed by **mark syntax inside a block** (`**`, `_`, `` ` ``, `<u>`,
`</mark>`, `[`, `](url)`) are syntax. A hunk overlapping them is *not* automatically structural —
see R3's mark-aware refinement — but is never a plain text hunk.

**Rationale**: the map is sorted/non-overlapping by construction, so resolution is O(log n); the
"one block" constraint is precisely FR-007's definition of a text hunk.

**Alternatives**: mapping through ProseMirror positions (parse md → PM → walk): rejected —
introduces a second coordinate system and a parse that must agree with the serializer; the direct
map cannot disagree with the serializer because the serializer emits it.

## R3. Hunk classification algorithm

### Input

`diffChars(baselineCanonicalMd, pushedCanonicalMd)` from npm `diff` v8 (already a dependency;
`diff-service.js` uses `diffLines`). Output: ordered change objects `{value, added, removed,
count}`. Convert to **anchored hunks**: walk the change list tracking `oldPos`/`newPos`; a hunk is
a maximal cluster of adjacent added/removed parts, giving `{ oldStart, oldEnd, newText }` in
baseline-md coordinates (all mapping happens against the *baseline's* source map, since ops are
replayed on the fork which is exactly at baseline state).

Cluster hunks with a small join distance of 0 (only literally adjacent removed+added merge; do
NOT merge across common text — preserving untouched spans is the whole point).

**`diffChars` vs `diffWordsWithSpace`**: character diff gives minimal edits but can scatter
(e.g. `s/cat/car/` is fine, but rewrites can produce confetti). Decision: use `diffChars` with
post-pass hunk *coalescing within a block*: if two text hunks in the same block are separated by
< 3 unchanged chars, merge them (still character ops, marginally coarser, far fewer ops). This is
an implementation-tunable constant, not protocol surface. Determinism (FR-011/D5): the `diff`
package is a pure deterministic Myers implementation — same inputs, same hunks.

### Classification (FR-007, decision table)

For each hunk, using the baseline source map:

1. **Whole-block insertion/deletion detection first** (structural by definition): if the hunk's
   old range covers one-or-more *complete* block extents (including their `\n\n` separators) with
   at most run-internal remainder, or the hunk inserts text containing a block boundary (`\n\n`)
   or any line-start block-syntax token, it is **structural**.
2. **Text-hunk test**: old range [oldStart,oldEnd) resolves (R2) entirely to text runs of one
   block, AND `newText` contains no characters that would alter block structure (no `\n`, no
   block-start tokens — since any md the pusher writes inside a paragraph's text span that
   introduces `\n\n` splits the block) AND `newText` contains no *inline mark syntax* (else the
   inserted chars would be literal `**` text where the pusher meant bold). If yes → **text hunk**.
3. **Mark-syntax refinement (prefer-text rule)**: if the hunk fails (2) only because its range
   touches inline mark syntax or `newText` contains inline mark syntax, re-diff *that block* at
   inline granularity: parse the block's old and new md via `parseInline`/`markdownToPm` into
   delta form, and compute a **delta-level diff** (insert/delete/format ops). If the block's node
   *type and attrs* are unchanged (paragraph stays paragraph, heading level unchanged), replay as
   character + format ops on the block's existing text node(s) → still a **text hunk** (this is
   what makes `*bold*`→plain-edit inside a paragraph non-destructive). If node type/attrs changed
   → **structural**.
4. **Everything else → structural**: replace the affected block range on the fork with nodes
   parsed by `markdownToPm` from the corresponding new-md range (expand hunk to enclosing block
   boundaries on both sides using `sourceMap.blocks` for old and a block scan of the new md for
   new; contiguous structural hunks merge into one replacement range).

The classifier's ordering encodes "prefer the text interpretation whenever a hunk can be
expressed as one" (FR-007): (2) and (3) are tried before falling to (4).

**Replay of a text hunk** on the fork: `textNode.delete(textOff, len)` /
`textNode.insert(textOff, str, attrs)` where `attrs` = the marks at the insertion point per the
old delta (step 3 supplies explicit format ops via `textNode.format(...)` when mark spans
changed). All inside one `fork.transact()`.

**Replay of a structural hunk**: parse replacement md → PM JSON (`markdownToPm`) → materialize as
Y nodes using the same clone/build helper pattern as `restoreVersion`'s `cloneXmlElement`
(`server/version-history.js:607-633`) generalized to build from PM JSON (this builder is 002's
`markdown-import.js` materializer — consumed, not re-implemented) → `fragment.delete(idx, n)` +
`fragment.insert(idx, nodes)` for the affected top-level block range on the **fork**. Indices here
are fork-tree indices derived from `sourceMap.blocks`, computed against the frozen baseline fork —
not positional targeting of the live doc (the live doc is never touched; Constitution IV's
structural-targeting rule is satisfied because the fork *is* the baseline snapshot the map was
built from, and blocks are identified by identity/extent, not by guessed live positions).

**`lossy:` mark exclusion (FR-010)**: before diffing, serialize the baseline fork with the pushed
file's flavor + lossy set (003's serializer options): baseline canonical md is produced *in the
pushed file's flavor*, so a portable-flavor file diffs against portable-flavor baseline md and
degradation cancels out. Character ops then never touch doc-side lossy marks because those marks
produce no md syntax in that flavor. This is cleaner than post-filtering diff hunks. The response
re-export likewise uses the pushed flavor (FR-014).

**Alternatives considered**:
- *Always block-replace changed blocks* (line-level diff like diff-service): rejected — violates
  FR-008/Constitution IV for intra-block edits; destroys concurrent same-block edits and marks.
- *diff-match-patch dependency*: rejected — `diff` is already present and sufficient; no new deps
  (Constitution: dependency posture).
- *Word-level diff*: rejected as primary (coarser than needed); coalescing post-pass on char diff
  gets the same op-count benefit while keeping character precision available.

## R4. Fork mechanics and synthetic clientID

### How Y.Doc clientID works (yjs API, verified against installed yjs)

Every `new Y.Doc()` gets a random 32-bit `clientID`. All ops created by a doc are stamped with its
clientID; `Y.encodeStateAsUpdate(doc, sv)` encodes exactly the ops missing from state-vector `sv`.
A doc's clientID can be set at construction (`new Y.Doc()` then `doc.clientID = n` — a documented,
settable property) provided no ops have been created under the old ID.

### Decision: deterministic synthetic clientID per (doc, baseline, content)

```
fork = persistence.getYDocAtClock(docGuid, baselineClock)   // gc: default true is fine — the fork
                                                            // only creates NEW ops; deleted-item
                                                            // history is not consulted
baselineSV = Y.encodeStateVector(fork)
fork.clientID = syntheticClientId(docGuid, baselineClock, sha256(canonicalPushedMd))
   // 32-bit: first 4 bytes of sha256("squire-sync\0" + docGuid + "\0" + clock + "\0" + contentHash),
   // with bit 31 cleared to stay in Yjs's uint32 space (and avoiding 0)
fork.transact(() => { ...replay all hunks... })
pushUpdate = Y.encodeStateAsUpdate(fork, baselineSV)        // = ops-since-baseline, all under the
                                                            // synthetic clientID
```

This is precisely `restoreVersion`'s forward-update pattern (`server/version-history.js:594-666`:
temp doc → capture pre-state-vector → transact mutation → `encodeStateAsUpdate(temp, sv)` →
store/apply), with two differences: the temp doc starts at the *baseline* clock (not current), and
the clientID is pinned.

**Why deterministic clientID (D5/FR-011)**: Yjs idempotence works at the (clientID, opClock)
level — re-applying an update whose ops the doc has already seen is a no-op. A retried push
replays the identical edit script (same fork state, same hunks in same order → same op clocks)
under the same clientID, so the second `applyUpdate` deduplicates perfectly: no doubled content.
With a *random* clientID, a retry would double-insert. Hash includes content so a *different* push
from the same baseline gets a different identity (two distinct offline editors), while an identical
retry gets the same one. Collision risk with a real editor's random clientID is the same 2^-31
birthday risk Yjs already accepts between random clients; acceptable.

**Determinism requirements this imposes on replay** (test-enforced): hunks replayed in ascending
old-offset order; no wall-clock, randomness, or Map-iteration nondeterminism in the edit script;
`getYDocAtClock` applies updates in fixed clock order (it does — `ORDER BY clock ASC`).

**Application to the live doc**: via `document-service.getSharedDoc(docGuid)` +
`Y.applyUpdate(sharedDoc, pushUpdate, createOrigin(userId, agentName))` — the same call shape as
`restoreVersion` (`version-history.js:681`). The bindState `'update'` listener then persists it as
**one stored update** with attribution (`server/index.js:184-231`), broadcasts to live editors, and
marks the search index dirty — the "normal update path" of FR-008, for free. When no live doc is
open, `getSharedDoc` binds one (same as restore/MCP paths). Rejections happen before any of this,
so failed pushes leave zero trace (FR-015).

`agentName` for the origin: a fixed identity string `'Repo Sync'` (constant in
`markdown-sync.js`), so version history shows agent-style attribution "Repo Sync (Token Owner)"
via the existing `createAuthor` logic — indistinguishable in mechanism from other agent edits
(US4 scenario 1).

**Alternatives**:
- *Random clientID + server-side retry dedup table*: rejected — new state, new failure modes,
  and D5 explicitly chose determinism over mechanism.
- *Replaying into the live shared doc directly under a transact*: rejected — violates FR-004 (live
  doc consulted/mutated during replay; concurrent edits would interleave mid-script and
  determinism dies).

## R5. Overlap detection via state vectors

### Decision

Overlaps = blocks with doc-side changes since baseline ∩ blocks with push-side ops.

- **Doc-side changed blocks**: load the live doc's current state (from the shared doc's snapshot
  or `getYDoc`), compute `baselineSV = getStateVectorsAtClocks(docGuid, [baselineClock])`
  (existing method, `postgres-persistence.js:497`). Walk the current doc's top-level blocks; a
  block changed since baseline iff it contains any item (element, text item, or deletion) whose
  id's clock ≥ `baselineSV[id.client]` — detectable by walking Y item trees, plus delete-set
  comparison (`Y.encodeStateAsUpdate(liveDoc, baselineSV)` decoded, or simpler: reconstruct
  baseline doc — we already have the fork pre-replay — serialize both docs' blocks to canonical md
  block lists and diff those at block granularity, correlating by position through an LCS). Chosen
  implementation: **block-level canonical-md LCS between baseline fork (pre-replay) and current
  live snapshot** — it is observable-state-based, avoids Y-internals spelunking, and "changed"
  matches what a user sees. State vectors gate the fast path: if `baselineSV == currentSV`
  (clock-equal push), skip — zero doc-side changes.
- **Push-side touched blocks**: recorded during replay (each hunk knows its block extent(s));
  identified by baseline block index and correlated to the same LCS.
- **Flag payload**: for each overlapping block: baseline block index, block type, a short text
  excerpt (first ~80 chars of block text), and change kinds (`docSide: edited|deleted`,
  `pushSide: text|structural|deleted`). Advisory only; never gates application (FR-012).

Note honest scope: the LCS approach reports block-level overlap (matches FR-012's "blocks changed
on the document side"); it does not attempt span-level intersection. SC-006's "no false negatives"
is evaluated at block granularity per the spec's own definition.

**FR-012 letter vs. mechanism**: FR-012 (and the design doc) name state-vector comparison as the
identification mechanism. In this plan, state vectors are the *gate* (baseline SV vs. current SV
determines whether any doc-side change exists at all, and the clock-equal fast path), while block
*identification* uses the observable-state LCS above — functionally equivalent at the block
granularity FR-012 specifies, chosen because the item-clock walk requires Y-internals traversal
used nowhere else in the codebase. If implementation finds the LCS too coarse (e.g. moved blocks
misreported), the state-vector/item-id walk is the documented upgrade path and would then satisfy
FR-012's letter directly. This deviation is deliberate and surfaced in the analyze report.

**Alternatives**: pure state-vector/item-id attribution walk (decode which blocks contain
post-baseline item ids): more "CRDT-native" but requires deep Y internal traversal
(`item.id.clock`, delete-set decoding) that the codebase nowhere else does; kept as noted upgrade
path if the LCS proves too coarse for moved blocks.

## R6. Baseline validation and rejection taxonomy (FR-015, US5)

- Parse `squire.clock` from frontmatter (003's parser surfaces it); explicit request param
  overrides (D3). Missing both → `400 sync_baseline_missing`.
- Non-integer / negative → `400 sync_baseline_invalid`.
- `> ` document's current max clock (`_getCurrentUpdateClock`) → `400 sync_baseline_invalid`
  (with `currentClock` in the body for tooling).
- Reconstructible check: today always true (full log, D1); the *contract* still defines
  `410 sync_baseline_unavailable` for a clock the server cannot reconstruct (forward guard —
  code path exists, returns based on a `canReconstruct(docGuid, clock)` hook that presently
  always returns true for valid clocks; a unit test forces the hook false to exercise the path).
- Frontmatter `docGuid` present and ≠ route `:docId` → `409 sync_doc_mismatch` (rejected before
  any processing, FR-002). 409 here is *identity mismatch*, not an edit conflict — the protocol
  still has no conflict-based rejection.
- All rejections: machine-readable `{ error: <code>, message, guidance: "re-pull ..." }`, no doc
  mutation, no version entry (rejection happens before fork/replay).

## R7. No-op detection (FR-009, US3)

After canonicalization (parse pushed md through 001's parser → serialize via canonical serializer
in the pushed flavor with lossy exclusions per R3), compare against baseline canonical md:
string-equal → respond `{ noop: true, clock: currentClock, markdown: <re-export at current state> }`,
skip fork/replay/store entirely. Note the diff being empty is equivalent (diffChars returns one
common part) — string compare is the cheap pre-check. The re-export in the no-op receipt is of the
**current** doc (D7), not the baseline, so the tool picks up doc-side edits.

## R8. Response receipt (FR-014) and route integration

`PUT /api/docs/:docId/import?mode=sync` (extends 002's route; body `text/markdown`, same size
caps/content-type rules). Optional params: `baselineClock` (override, D3), `onBehalfOf*` fields
via headers or query (`X-Squire-On-Behalf-Of-Name/-Email/-Commit/-Url`, each length-capped ~256
chars, stored as text; D6). Success receipt:

```json
{
  "docId": "...", "mode": "sync", "noop": false,
  "clock": 1507,
  "markdown": "---\nsquire:\n  clock: 1507 ...\n---\n...",   // canonical re-export, pushed flavor,
                                                              // refreshed frontmatter (next baseline)
  "overlaps": [ { "blockIndex": 3, "blockType": "paragraph", "excerpt": "...",
                   "docSide": "edited", "pushSide": "text" } ],
  "operations": { "textHunks": 4, "structuralHunks": 1 }
}
```

The `clock` returned is the stored update's clock from the normal path. Because bindState's
persistence is asynchronous (fire-and-forget inside the `'update'` listener), the sync route
obtains the clock by calling `persistence.storeUpdate(...)` directly first and then applying to
the shared doc (exactly `restoreVersion`'s order: store → applyUpdate-with-origin; the listener's
re-store hits `ON CONFLICT DO NOTHING` — dedup already proven by restore). This also yields the
one-update/one-clock atomicity of FR's persistence edge case: `storeUpdate` either lands or the
push 500s untouched.

**Post-store consistency for the receipt's re-export**: re-export serializes the *shared doc state
after applyUpdate* (fork delta + whatever concurrent edits exist at that moment) — matching D7's
"always rewrite the local file from the receipt".

## R9. Convergence property test design (FR-017/SC-002)

For generated cases (corpus of docs × edit scripts × concurrent-edit scripts):

1. Build doc at baseline; export canonical md.
2. **Real offline client**: `clientDoc = getYDocAtClock(...)` clone, make the *same semantic
   edits* via direct Yjs calls (the edit script is expressed as Yjs ops so it can be applied both
   ways), `clientUpdate = encodeStateAsUpdate(clientDoc, baselineSV)`.
3. **Push path**: apply the edit script to a scratch doc → serialize to md → push that md through
   `markdown-sync` against the same baseline.
4. Apply live-side concurrent edits to the live doc in permuted orders relative to (2)/(3)
   application; assert final canonical serialization identical in both worlds and across orders
   (order-independence, SC-004: apply pushUpdate before/after/interleaved with concurrent
   updates — Yjs commutativity makes final state equal; test asserts it).

Equality is asserted on canonical markdown + `extractXml` (structure + marks), not update bytes —
clientIDs differ between the two worlds by construction, so byte equality is neither expected nor
required; *state* equality is the spec's claim ("same final document state").

## R10. Storage for onBehalfOf (D8 — new ratified default, recorded in ledger)

**Decision**: additive migration `yjs_updates.on_behalf_of JSONB NULL` — written only by sync
pushes (extend `storeUpdate` with an optional metadata arg defaulting null), read by the
version-history query path (`_queryUpdatesWithUsers` gains the column; `createAuthor`/timeline
formatting surfaces it as capped plain text). No backfill, no index (queried only alongside rows
already being read). Prominently flagged: this is the plan's one migration; spec said "if a
migration proves necessary, flag prominently" — it is flagged in plan.md Complexity Tracking,
ledger D8, and tasks.md.

**Rationale/alternatives**: see plan.md Complexity Tracking (agent_name overload corrupts author
rendering; side table is also a migration plus a join; ephemeral storage breaks durability parity
with version history).

## R11. Performance sanity (SC-007)

1 MB markdown ≈ 1M chars: `diffChars` is O(ND) Myers — worst case (total rewrite) is large but
`maxEditLength` option provides a cliff guard: set generous cap (e.g. 200k edits); on `undefined`
result (cap exceeded), fall back to **coarser hunking**: `diffLines` first, then `diffChars`
within changed line clusters only — bounded work, same classification pipeline. Baseline
reconstruction: same cost as existing version-history views (acceptable today at current doc
sizes; the 10 s budget is generous). Re-export + LCS overlap: linear. No new caching needed for
v1.

## Resolved NEEDS CLARIFICATION

Technical Context contained none; D1–D7 pre-ratified in `clarifications-needed.md`; D8 added by
this plan (see R10).
