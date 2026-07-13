# Promotion Notes: 004-two-way-sync

Populated during implementation. Items the merge queue / reviewer / maintainer
should know. Nothing here blocks merge; all decisions have a documented default.

## Implementation deviations from plan.md (adapted, non-blocking)

1. **Module locations** (plan.md assumed different paths; T001 records the real
   ones, code adapted): the parser is `shared/markdown` (not
   `server/markdown-to-pm.js`); the format registry is `shared/format-registry`
   (not `server/`); the PM-JSON→Yjs materializer is
   `server/mcp/yjs/pm-json-to-nodes.js` (`pmJsonToNodes`); frontmatter parsing is
   `parseFrontmatter` in `shared/markdown/frontmatter.js` (imported directly).
   All surfaces exist and are shaped compatibly.

2. **Single stored update via ORIGIN_DB_LOAD broadcast** (differs from
   restoreVersion). `applySyncPush` stores the update directly (the one durable,
   attributed row carrying `on_behalf_of`), then broadcasts to live editors with
   the `ORIGIN_DB_LOAD` sentinel so the persistence listener does NOT write a
   second, unattributed row. restoreVersion tolerates that double-write because
   it carries no per-row metadata; sync cannot (FR-008 "single stored update" +
   provenance). Search-index-dirty is marked explicitly to compensate for the
   suppressed listener. **Merge queue: this is a deliberate, tested behavioral
   choice, not the restoreVersion pattern verbatim.**

3. **Overlap detection uses block-level canonical-md LCS** (research R5's chosen
   implementation), with state vectors as the fast-path gate (clock-equal →
   skip). FR-012 names state-vector comparison as the identification mechanism;
   the LCS is functionally equivalent at the block granularity SC-006 specifies
   and avoids Y-internals traversal used nowhere else. If a reviewer needs
   span-level or moved-block precision, the state-vector/item-id walk is the
   documented upgrade path. Already flagged in research R5.

4. **Performance thresholds** (T027/R11): to bound the `diffChars` O(N·D) bail
   cost, inputs over 64 KB combined skip the whole-document char diff and go
   straight to line-level coarse hunking (`MAX_EDIT_LENGTH=10000`,
   `COARSE_INPUT_THRESHOLD=64KB`, `COARSE_CLUSTER_MAX=16KB`). Research R11
   suggested a generous 200k cap; that cap's bail cost is itself O(N·200k) and
   too slow for large inputs, so the size-based routing supersedes it. A ~1 MB
   push returns in <1 s.

5. **resolveImageRefs** (T028): added `./assets/` → app-URL resolution via the
   file's `squire.images` map before diffing, so bundle-exported files round-trip
   to a no-op. Implied by the spec Images edge case; not a separate task line.

6. **Source-map assembly** hardened: block absolute offsets are computed directly
   from the assembled block join (leading-trim shift + trailing clip) rather than
   a fragile `indexOf`-locate, so a block that ends/begins in whitespace (which
   the serializer's final `.trim()` strips) maps correctly. Guarded fallback to
   `indexOf` if an internal `\n{3,}` collapse ever shifts mid-document offsets.

## OWED-AT-MERGE — Squire design-doc amendment (Constitution VI)

- **`design/markdown-import-two-way-sync.md` §2.4.1 (overlap detection)** names
  state-vector comparison as the mechanism for identifying doc-side changed
  blocks. The shipped implementation uses state vectors as the gate and a
  block-level canonical-md LCS for identification (equivalent at block
  granularity; see deviation #3). If the maintainer wants the doc to match the
  code exactly, amend §2.4.1 to describe the SV-gate + LCS approach (and its
  block-granularity honesty for SC-006). Exports are not hand-edited — amend the
  source Squire doc, then `node design/sync.mjs`.

## RATIFIED-BY-DEFAULT decisions to surface to Sam

- D1–D8 in `clarifications-needed.md` (all pre-authorized). D8 (the one
  migration, `yjs_updates.on_behalf_of JSONB NULL`) is the only schema change.

## Post-merge review follow-ups (reviewer promotion notes)

Raised by the adversarial post-merge review of 004. F1–F5 were fixed in-tree
(same-day); the notes below are the residual, non-blocking observations the
reviewer asked to carry forward.

1. **Multi-XmlText offset assumption is assertion-worthy.** The offset resolver
   and `reconcileBlockPlan` assume a block reconciled in place has exactly ONE
   `Y.XmlText` child (`reconcileBlockPlan` bails to structural when
   `textChildren.length !== 1`). The surgical text-hunk path in `applyHunks`
   tracks a per-node offset shift that is only sound under that single-text-node
   shape. It holds for every block type the serializer currently emits, but the
   assumption is implicit — add a defensive assertion (or an explicit
   multi-text-node guard) so a future schema/serializer change that puts two
   `Y.XmlText` siblings in one block fails loudly instead of mis-anchoring an
   offset.

2. **Pin jsdiff's emoji tokenization with a regression test.** `computeHunks`
   and `reconcileTextNode` diff on `diffChars`, which tokenizes by UTF-16 code
   unit — an astral-plane emoji (surrogate pair) can be split across hunks. The
   replay is still correct today because ops are re-anchored and the CRDT
   applies whole inserts, but the behavior rides on jsdiff internals. Add a
   regression test that pushes an emoji edit (e.g. inserting or deleting a 👍 or
   a combining sequence) and asserts the resulting document is intact, so a jsdiff
   upgrade that changes tokenization can't silently corrupt astral text.

3. **Portable source-map coverage gap.** The source-map tests exercise the
   squire flavor thoroughly but the portable flavor thinly. Portable degradation
   shifts inline offsets (HTML-tag marks → shorter/longer delimiters; textStyle
   dropped), and the source map is rebuilt on the portable serialization. F2
   touched the portable reconcile path; a dedicated portable source-map suite
   (offsets of runs/blocks under underline→`_`, highlight→`**`, textStyle-drop)
   would lock in that the offset math stays correct as portable declarations
   evolve.

4. **Retry row accretion — CLOSED by F5.** Previously: a retried/duplicate push
   deduped its CONTENT (pinned synthetic clientID) but still stored a no-op
   version row. F5's idempotency short-circuit (`pushIsAlreadyApplied`, snapshot
   before/after applying the fork update) now returns the no-op receipt and
   stores nothing when the update is already applied — covering both re-inserted
   structs and re-applied deletions. No residual accretion remains.

5. **Per-version `onBehalfOf` list is uncapped.** The version timeline
   aggregates every push's on-behalf-of provenance into a per-version list with
   no upper bound. Each entry is already field-whitelisted and length-capped
   (D6, `sanitizeOnBehalfOf`), so no single entry is hostile, but a version that
   absorbs a very large number of attributed pushes could grow an unbounded
   array in the timeline payload. Consider a per-version cap (with a "+N more"
   overflow) before a high-frequency CI pusher exercises it.

## Follow-ups deferred to M5 (squire-sync CLI / GitHub Action)

- Per-document token scoping (D2) — revisit before a GitHub Action encourages
  long-lived repo-secret tokens.
- The reference sync CLI / Action is a separate feature; this feature's contract
  is API-first so tooling can implement pull/push against it today.
