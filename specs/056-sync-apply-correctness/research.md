# Research: Sync Apply Correctness and Honest Receipts (056)

**Input**: spec.md, clarifications-needed.md (RBD-056-1..7), design amendment
"Amendment (2026-08-11) — apply correctness and honest receipts (feature 056)"
in `design/markdown-import-two-way-sync.md`, and a direct read of
`server/markdown-sync.js` at the anchors the spec cites (file contains NUL
bytes — use `grep -a` or direct reads).

All decisions below were made against the actual merged 054+055 code on main
(verified 2026-08-12). No NEEDS CLARIFICATION markers remain; product-level
defaults live in `clarifications-needed.md` and are referenced, not re-decided,
here.

---

## R1 — Plan-recorded mark attribution (FR-001/002/003, Bug A)

**Decision**: The classifier records the resolved run's mark attributes on the
hunk at plan time; apply formats inserted text with exactly those attributes
and the `at - 1` delta probe in `applyHunks` step 2 (`markdown-sync.js:1251`)
is deleted.

Mechanics:

- Source-map runs are maximal same-marks spans by construction
  (`server/mcp/yjs/serialization.js` ~:442, runs built at :814/:836 as
  `{ mdStart, mdEnd, textNode, textOff }`). Therefore ANY character inside a
  run carries the run's marks, and sampling one character of the resolved run
  from the pristine baseline fork at plan time is exact.
- `classifyRange` (:193-233) keeps its resolution order verbatim (RBD-056-5):
  (1) offset strictly inside a run → that run; (2) offset at a preceding run's
  `mdEnd` → left run; (3) offset at a following run's `mdStart` → following
  run; (4) otherwise → structural. The ONLY change: each resolved insertion
  segment gains an `attrs` field — the resolved run's marks, sampled via the
  run's own span (inside → char at the resolved offset; left rule → the run's
  last char, `textOff + (mdEnd - mdStart) - 1`; following rule → the run's
  first char, `textOff`). Sampling uses the existing `marksAtChar` helper over
  `textNode.toDelta()` at plan time (fork untouched, offsets pristine).
- Proper-range (replacement) hunks record `attrs` from the FIRST replaced
  character's run (`segments[0]`, char at `seg0.textOff`): replacement text
  takes the replaced text's marks. Today's apply-time probe reads the
  character that happens to sit at `at` *after* the delete (i.e. whatever
  followed the deleted range) — the same nondeterministic neighbor-probing
  disease as Bug A, and the reason the net-zero delete+reinsert variant
  reproduces identical wrong attrs. For ranges strictly inside one run the
  two agree; where they diverge (range ending at a run boundary) the
  plan-side rule is the deterministic one and the corpus + existing
  replay/convergence suites gate it.
- `applyHunks` step 2 becomes: delete (unchanged), then
  `textNode.insert(at, h.newText, attrs)` where `attrs` comes from the hunk's
  recorded segment — no `toDelta()` probe, no anchor arithmetic. Empty attrs
  → plain insert (unchanged behavior).

**Rationale**: The plan already resolves the correct run (verified: repro3 P1
comma-after-link resolves via rule 3 to the following plain run; apply then
discards that answer at :1251). Recording attributes at plan time (a) removes
the only consumer of live-document mark state in the text lane, (b) is immune
to intra-node offset shifts from earlier hunks at apply time, (c) preserves
the left-preference branch bit-for-bit — rule order untouched, only which run
apply HONORS changes (the design amendment's exact words).

**Alternatives considered**: (a) apply-time probe at the recorded run boundary
— still a live probe, still shift-hazardous, fails FR-001's "MUST NOT probe";
(b) record a run index and re-sample at apply time — offsets shifted by
earlier hunks in the same text node make this wrong in exactly the multi-hunk
blocks the corpus exercises; (c) special-case "after closing syntax" only —
leaves replacements nondeterministic and fails the net-zero variant.

## R2 — Fold-together mechanics (FR-004, Bugs B/C carrier, RBD-056-7)

**Decision**: `planPush` (:987-1041) gains a post-classification fold step
enforcing the invariant *a block appears in at most one lane*:

1. After the classification loop, compute `structuralClaims` = the set of
   source-map blocks referenced by any non-forced structural hunk's `blocks`
   list (single- and multi-block claims alike). Edge-block insertions
   (`blocks: []`, `isEdgeBlockInsertion`) claim nothing — insertions BESIDE a
   block are not edits OF it (spec edge case).
2. Any per-block text group whose block is in `structuralClaims` is folded:
   its hunks are re-emitted as structural hunks carrying `blocks: [block]`
   instead of entering `textBlocks`/`reconcileBlocks` (fold runs BEFORE the
   `reconcileBlockPlan` attempt — a folded group never tries reconcile).
3. `structuralOps` (:1176-1210) already coalesces per-block-range groups and
   `applyHunks` step 3 (:1276-1280) already composes the rebuild string from
   ALL hunks of a group in `oldStart` order over
   `[firstBlock.mdStart, lastBlock.mdEnd]` — so once every hunk of the block
   reaches the structural lane, the rebuild is complete by existing
   construction. No apply-side rebuild change is needed for FR-004.
4. Counts: folded hunks count toward `structuralHunks`, never `textHunks`
   (RBD-056-7); `blocksChanged` reports the folded block once, `op:
   'structural'` (buildChangeReport's `replaced` dedupe already guarantees
   single-reporting; after the fold the text-lane entries don't exist at all).
5. Forced (055 aligner-emitted) hunks NEVER trigger or participate in a fold:
   they carry their block's full new content by construction (FR-016; spec
   edge case). By 055's construction a block is either aligner-forced or
   char-diffed — never both; a defensive guard treats any violation as a
   skip (counted, R4) rather than a double-apply.
6. The apply-side skip guards at :1232/:1238 (`replacedNodes`) become
   defense-in-depth: with the fold in place no planner output can hit them;
   if a future path does, the skip is COUNTED in the apply result (R4), never
   silent.

**Rationale**: The bug is a planner-lane split (`:1002-1007` routes one
block's hunks to different lanes) meeting an apply-side claim (`:1224-1226`)
that rebuilds from only the structural group's hunks. Fixing it in the planner
(one lane per block) leaves `structuralOps`/`applyHunks` composition logic
untouched — the smallest change that makes "rebuild from ALL hunks" true by
construction, and it makes the receipt shape (RBD-056-7) fall out for free.

**Alternatives considered**: (a) apply-side merge — pull the skipped text
hunks into the rebuild string inside `applyHunks` — duplicates the planner's
grouping downstream and leaves the plan lying about its own lanes (the change
report reads the plan); (b) per-hunk conflict detection at apply — treats the
symptom, keeps silent-drop paths alive.

## R3 — Unbalanced brackets are mark syntax (FR-005, Bug C)

**Decision**: The plain-text gate in `planPush` (the `allPlain` predicate,
:1014-1017) treats square brackets as inline mark syntax on BOTH sides of a
hunk:

- `newTextHasInlineMarkSyntax` (:961-963) extends its character class to
  match `[` and `]` (today only `](` matches, so a lone `[` rides the
  plain-text lane — the exact Bug C entry point).
- A new deleted-text check: a hunk whose replaced baseline slice
  (`baselineMd.slice(oldStart, oldEnd)`) contains `[`, `]` (including the
  escaped `\[`/`\]` forms the serializer emits for literal brackets) is not
  plain either — a deletion that unbalances the block's remaining brackets
  must not ride the text lane (spec edge case "delete-only hunks").

Not-plain hunks route exactly as today: whole-block `reconcileBlockPlan`
first (full markdown re-parse of the block's complete intended content —
correct for literal `[sic]` and for real link syntax alike, because the
parser decides), structural rebuild as the fallback. Parentheses are NOT
added to the syntax class — the spec names square-bracket syntax; `](` stays
covered; a stray `)` in prose is legal text and the reconcile path would
handle any link-paren interaction that does arise via full reparse.

**Rationale**: Precisely computing "does this edit unbalance the remaining
markdown of the block" is fragile; conservatively routing bracket-bearing
hunks to the whole-block reparse lanes is correct by construction (the block
string is composed from ALL hunks post-R2, parsed as markdown, so balanced
input parses balanced output — FR-006). Over-classification cost is a
reconcile instead of a char splice: marks-preserving, in-place, and gated by
the round-trip/convergence suites.

**Alternatives considered**: (a) real bracket-balance analysis of the
composed block string — more precise, more code, and still needs the
conservative fallback for escapes; rejected as complexity without a corpus
scenario demanding it; (b) newText-only check — misses the deletion
direction the spec explicitly requires.

## R4 — Apply-result record and honest receipts (FR-007, RBD-056-2)

**Decision**: `applyHunks` returns an **apply result** instead of echoing
`plan.counts` (:1333):

```js
{
  textHunks, structuralHunks,   // performed work only (054 names, flat — existing
                                // callers read ops.textHunks off the return)
  skipped,                      // NEW
  outcomes: {
    reconciled:  [{ blockNode, applied }],
    textBlocks:  [{ blockNode, applied }],
    replacements: [{ first, last, applied }],   // per structural group
    insertions:  [{ afterBlock, applied }],
  },
}
```

`applySyncPush` builds the receipt's `operations` by picking the three count
keys (never forwarding `outcomes` to the payload).

- `textHunks`/`structuralHunks` keep their 054 names and meaning ("work
  performed") and are now counted AS operations apply — a text hunk counts
  when its ops run, a structural group counts its hunks when the rebuild
  lands, an insertion when its nodes insert.
- Every skip path increments `skipped` and marks its outcome
  `applied: false`: the replaced-block guards (:1232/:1238, dead post-R2 but
  guarded), an unresolvable block node (`indexOf === -1`, :1272), and an
  empty parse (`newNodes.length === 0`, :1322 — note: for a structural
  REPLACEMENT an empty parse is a legitimate deletion and stays "applied";
  only the insertion-path empty parse is a skip). `skipped` is 0 on every
  healthy push (RBD-056-2 — defense in depth for future paths).
- `buildChangeReport` keeps reading baseline-side inputs only (sourceMap
  extents + baselineMd string — both immutable across apply), and gains an
  optional `outcomes` argument: entries whose op did not apply are dropped.
  `applySyncPush` moves the report build AFTER the apply transaction (safe:
  no input of the report derives from live fork state; block identity keys
  are the same block objects) — or equivalently builds pre-apply and filters
  post-apply; either satisfies the contract "blocksChanged lists only blocks
  apply actually changed". The DB-free harness signature
  (`buildChangeReport(plan, sourceMap, baselineMd)`) keeps working — the new
  argument is optional, unfiltered output is the plan view (used by overlap
  detection inputs? — no: overlaps use `pushTouchedBlocks`, untouched).
- `mode=append`/`replace`/create receipts are untouched (out of scope).

**Rationale**: The receipt's sin is single-sourcing from the plan
(`operations` = `plan.counts` at :1333, `blocksChanged` pre-transaction at
:1788). Deriving both from one apply-produced record makes every current and
future skip path visible by construction, with 054's aggregate keys unchanged
(RBD-056-2) and the anomaly signal in two uncorrelatable-with-success places:
`operations.skipped > 0` and `converged: false`.

**Alternatives considered**: (a) entry-level `skipped` rows in
`blocksChanged` — rejected by RBD-056-2 (the re-export is ground truth; a
count is the alarm); (b) keeping the plan-derived report and asserting
apply-never-skips — exactly the "trust the plan" posture that produced the
field failure.

## R5 — `converged` computation (FR-008/012, RBD-056-1/-6)

**Decision**: Fork-side, one mechanism: after `applyHunks` runs inside the
fork transaction, serialize the fork fragment with the existing canonical
serializer in the push's flavor — `toMarkdown(fragment, { flavor })`, the
same dialect the diff's `canonicalMd`/`pushedMd` already use — and
`converged = (forkMd === pushedMd)`, byte equality. Computed once, used by
every receipt branch:

| Branch | `converged` |
|---|---|
| canonical-equal noop (`pushedMd === canonicalMd`, :1777) | `true` trivially — nothing to apply (spec edge case) |
| already-applied idempotency noop (:1799) | the fork comparison just computed — reproduces `false` for the field's S1 diverged-doc scenario (RBD-056-1) |
| dry run (:1842) | same value as a real push — fork-side needs no durable write (RBD-056-6) |
| applied push (:1896) | the pre-store fork comparison |
| net-zero apply | fork == baseline ≠ pushed → `false` with honest op counts (FR-009); no dedicated detector (RBD-056-3) |

Rejection bodies (`sync_baseline_stale` etc.) are not receipts and do not
carry the field. Live-doc divergence remains the province of the 054
staleness quartet (`docChangedSinceBaseline`) — `converged` measures the
engine's own application fidelity only (RBD-056-1, design gap 1 flagged).

**Cost**: one extra fork serialization per sync push (the cheap
non-source-map `toMarkdown` variant; 055 keeps the two byte-identical).
Bounded by document size like every existing per-push serialization; no new
scaling class.

**Rationale**: One byte-comparison covers every honest-receipt requirement
including net-zero shapes not yet imagined; the fork is available on every
branch including dry run; and RBD-056-1's ledger entry argues the noop branch
semantics in full.

## R6 — Noop receipt honesty (FR-010)

**Decision**: `noopReceipt` (:1760-1774) gains the computed `converged` value
and keeps `operations` zeros and `blocksChanged: []` — a noop performs
nothing NOW, and zeros are the truth about this push; `noop: true,
converged: false` is the designed re-pull-and-repair signal. The
canonical-equal branch passes `converged: true` without extra computation.
The already-applied branch (reached after plan+apply on the fork) passes the
R5 comparison. Dry-run noop receipts carry the same values (both noop
short-circuits are reachable under dryRun, per 054).

## R7 — Regression corpus encoding (FR-013/014/015, SC-001/002/004)

**Decision**: Two committed test surfaces, mirroring where the repro
investigation ran:

1. **DB-free replay suite** — new `server/__tests__/markdown-sync.apply-correctness.test.js`
   (Jest, no DB, parallel-safe per Constitution II). Encodes the four repro
   families from `specs/056-sync-apply-correctness/repro/repro{1..4}.js` as
   data-driven scenario tables sharing one replay harness (the repro scripts'
   `pushOnce` shape, which matches the existing `markdown-sync.replay.test.js`
   helper style). Per scenario it asserts:
   - **First-push convergence**: `resultMd === pushedCanon` (SC-001, FR-013).
   - **Repair-push convergence**: from any mis-state (including states
     produced by driving the OLD wrong shapes — reconstructed as fixture
     docs, e.g. a comma inside the link), one push of desired content against
     a fresh re-export converges (SC-002, FR-014), and a no-progress push
     reports zero-effect counts (the harness-level converged check).
   - **Receipt honesty**: `operations` from the apply result reflect
     performed work; `skipped === 0` on healthy pushes; `blocksChanged`
     filtered by outcomes lists only applied blocks; folded blocks appear
     once as `structural` (RBD-056-7).
   - **No raw syntax leak**: repro4's leak regex over every result (SC-004,
     FR-006).
   The four repro seeds stay committed under `specs/.../repro/` unchanged as
   evidence (design gap 4: the scratchpad originals were session-ephemeral —
   the specs copies + this suite are the durable form).
2. **Route-level receipt tests** — extend
   `__tests__/integration/sync-push.route.test.js` (the 054 receipt suite)
   with: applied push carries `converged: true` and unchanged 054 fields
   (FR-011); the FR-010 noop pair — route-level, a byte-identical re-push
   over a concurrency-diverged doc asserts the RBD-056-1 designed pair
   (`noop: true, converged: true, docChangedSinceBaseline: true`), while
   the `converged: false` backstop branch (unreachable naturally once the
   engine is correct — analysis finding U1) is asserted at the replay/unit
   seam with a doctored fork comparison; canonical-equal noop returns
   `converged: true`;
   `dryRun=true` returns the same `converged` a real push produces and still
   leaves no trace (FR-012, reusing 054's trace-freedom assertions).

**Rationale**: FR-015 mandates committed tests at the replay layer the
investigation used plus route-level noop/dry-run coverage — this is that,
verbatim, using existing harness idioms so the suite reads like the
neighboring 004/054/055 suites.

## R8 — Non-regression gates (FR-011/016/017, SC-006)

**Decision**: No changes to `computeHunks`' alignment pre-pass, forced-hunk
emission, similarity, or caps (055 frozen); no serializer changes; no schema
or migrations. The gate list run unchanged: `markdown-sync.replay`,
`markdown-sync.convergence` (the offline-client property — FR-013's design
anchor), `markdown-sync.alignment`, `markdown-sync.order-independence`,
`markdown-sync.overlap`, `markdown-sync.rejection`, `format-roundtrip`,
`markdown-fixtures`, `markdown-fuzz`, `import-roundtrip`-family, and
`sync-push.route` + `sync-push.cross-doc-images.route`. Round-trip no-op
(FR-017) is asserted where it already lives (canonical-equal noop tests),
now additionally checking `converged: true`.

Two behavior deltas are EXPECTED in existing suites and must be reviewed, not
suppressed, if they surface: (a) hunks with brackets in new/deleted text now
classify reconcile/structural instead of text (R3) — any existing test
asserting `textHunks` counts over bracket-bearing edits may need its
expectation updated to the new truthful lane; (b) replacement mark
inheritance is now plan-side (R1) — any test that (accidentally) pinned the
post-delete neighbor-probe semantics needs review against the spec rule.
Anything beyond those two classes is a regression, not an expectation update.

## R9 — Teaching/contract surfaces for the receipt addition

**Decision**: The receipt addition itself requires (spec out-of-scope
carve-out, Constitution I):

- New contract `contracts/sync-receipt-v3.md` in this feature (delta over
  054's `sync-receipt-v2.md`): `converged` on every sync receipt,
  `operations.skipped`, applied-derived semantics for
  `operations`/`blocksChanged`, noop-over-divergence signal. Additive only.
- Update the REST teaching surface that documents the sync receipt:
  `server/mcp/tools/tool-documentation/export-api.js` (~:212-291 documents
  the receipt shape, noop, and dryRun) — add `converged` +
  `operations.skipped` and the `noop:true, converged:false` repair signal.
- README.md: no current mention of receipt operation fields (checked
  2026-08-12 — grep clean), so no README edit is required unless implement
  finds sync-receipt prose elsewhere; docs-site pages were 054's FR-015
  scope and are out of scope here.

No MCP tool-parameter changes; no privacy/policy surfaces touched.
