# Feature Specification: Sync Apply Correctness and Honest Receipts

**Feature Branch**: `056-sync-apply-correctness` (spec directory; work is orchestrated on the current branch — no feature branch is created by the spec phase)

**Created**: 2026-08-12

**Status**: Draft

**Input**: User description: "Apply-layer correctness + honest receipts for the markdown sync engine (feature 056-sync-apply-correctness)"

**Design ground truth**: `design/markdown-import-two-way-sync.md` — §2.4/§2.4.1 (offline-collaborator replay model) and "Amendment (2026-08-11) — apply correctness and honest receipts (feature 056)" (commit 3f6b50fb), read together with the two prior 2026-08-11 amendments (054 receipts/staleness, 055 block-aligned merge). Source field report: https://squiredocs.com/d/aa76378c-3002-4b76-935a-9f15bc7e376e (context; the amendment is authoritative).

## Problem Statement

The 054/055 work fixed what the sync engine *plans*; a post-deploy field
verification showed the *apply* layer can still corrupt a push and then
certify the corruption as success. Three defects, all reproduced with zero
concurrency at the DB-free replay layer (fork → plan → apply → serialize),
plus a receipt-trust defect:

- **Bug A — apply-time mark inheritance.** When a plain-text hunk inserts
  text, apply probes the document for the marks of the character *before*
  the insertion point (`applyHunks` step 2, `server/markdown-sync.js:1251`,
  anchor `at - 1`). An insertion that is right-adjacent to closing mark
  syntax — a comma typed after `[runbook](url)` — therefore inherits the
  LINK's marks and joins the link. The plan had already resolved the
  insertion to the *following* plain-text run; apply discards that answer.
  Because a repair push re-plans the same shape, it re-applies the same
  wrong marks forever: the receipt shows real ops (`textHunks: 2`), a
  stored update, and a clock advance, while the document never reaches the
  pushed state. Bold hits the same bug on the first push but self-heals via
  the whole-block reconcile path; links are the durable failure. A
  net-zero variant deletes and reinserts with identical wrong attrs,
  leaving the document byte-identical while the receipt claims changes.
- **Bug B — a block's hunks are split across lanes and half dropped.** The
  planner can route one block's hunks down different lanes (text /
  reconcile / structural, `planPush`, `:1002-1007`). When any of them is
  structural, apply claims the whole block for structural replacement
  (`:1224-1226`), skips that block's reconcile and text edits (`:1232`,
  `:1238`), and rebuilds the block from **only the structural group's
  hunks** (`:1276-1280`). "Consult the [runbook](rb2)": the URL edit
  applies, the word swap silently vanishes, and the receipt shows one
  clean structural op.
- **Bug C — raw `](` leaks into documents.** A lone `[` is not matched by
  the inline-mark-syntax test (`newTextHasInlineMarkSyntax`, `:961-963`),
  so an insert-`[` hunk classifies as plain text; Bug B then drops it from
  the structural rebuild, the rebuild string is unbalanced markdown, and
  the parsed result contains a literal `](` plus a link whose display text
  is the URL. The document is stuck in this state under repair pushes.
- **Receipts report the plan, not the outcome.** `blocksChanged` is built
  from the plan before the apply transaction (`:1788`); `operations` is
  `plan.counts` (`:1333`); none of apply's skip paths (`:1272`, `:1232`,
  `:1238`, `:1322`) feed back into either. And the idempotency
  short-circuit (`pushIsAlreadyApplied`, `:1575`, used at `:1799`) returns
  a clean `noop: true` even when the live document has diverged from the
  pushed file — the exact situation a repairing agent needs to be told
  about.

The ratified contract (design amendment, feature 056): mark inheritance is
a plan-side decision; a block's hunks travel together into any structural
rebuild; unbalanced brackets count as mark syntax; receipts derive from
apply results; and every sync receipt gains a `converged` field that
compares what apply actually produced against what was pushed — so a push
that did not take effect can never read as a clean success.

An investigation already reproduced every failure at the replay layer; its
four repro scripts (`repro1.js`–`repro4.js`, ~40 scenarios: link/bold
boundary edits, mixed URL+text edits, unwrap/move/add link shapes, repair
loops, stale-baseline noop, link fuzz) are the regression-test seeds for
this feature and MUST be encoded into the committed test suite.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Edits next to formatting apply exactly as written (Priority: P1)

An agent (or human) edits the repo copy of a synced doc, adding a comma
right after a link: `[runbook](url), before deploying`. It pushes the
file. In Squire the comma is plain text — it does not join the link, the
link's text and URL are unchanged, and the receipt's re-export is
byte-identical to the pushed file.

**Why this priority**: This is the durable field failure. A comma
swallowed into a link is user-visible corruption, and because the wrong
state re-plans identically, no number of sync pushes can ever fix it —
the field agent's only exit was destructive `mode=replace`.

**Independent Test**: Replay the repro1/repro3 boundary-insertion corpus
(comma after link, suffix on link text, word before link, same shapes for
bold) through the push engine and verify each scenario's post-apply
serialization equals the pushed canonical markdown on the first push.

**Acceptance Scenarios**:

1. **Given** a paragraph `Check the [runbook](url) before deploying.`,
   **When** a push inserts `,` immediately after the closing `)`, **Then**
   the applied comma carries the following plain-text run's (lack of)
   marks, the link is unchanged, and the re-export equals the pushed file.
2. **Given** the same paragraph, **When** a push appends a character to
   the link display text (`runbook` → `runbooks`), **Then** the new
   character IS part of the link (insertion inside the mapped run keeps
   that run's marks).
3. **Given** a paragraph ending in a bold span, **When** a push inserts
   plain text immediately after the closing `**`, **Then** the inserted
   text is not bold — on the first push, not via a later self-heal.
4. **Given** any scenario above already mis-applied by the old engine
   (e.g. a comma stuck inside a link in the live doc), **When** the
   desired state is pushed against a freshly re-exported baseline, **Then**
   the push converges: the document reaches the pushed state in one push.
5. **Given** normal typing at the end of a styled span (insertion at a
   run boundary where the preceding run's mapped text ends exactly at the
   insertion offset, with no intervening syntax), **When** the push
   applies, **Then** the text continues the preceding span — the existing
   left-preference behavior is preserved unchanged.

---

### User Story 2 - No edit in a pushed file is silently dropped (Priority: P1)

An agent pushes a file that both changes a link URL and swaps a word in
the same paragraph. Both edits land. If any edit of a block requires the
block to be structurally rebuilt, the rebuild reflects **all** of that
block's edits — never a subset — and the rebuild never injects raw
markdown syntax (`](`, stray brackets) into the document as literal text.

**Why this priority**: Silent partial application is the worst sync
failure: the receipt says success, the file says one thing, the document
says another, and nothing points at the gap. The raw-`](` leak (Bug C) is
the same defect wearing a visible face.

**Independent Test**: Replay the repro2 mixed-edit corpus (URL edit + word
swap, URL + display text, unwrap + edit, linkify a word, multi-block
variants) and the repro4 fuzz corpus; verify first-push convergence and
zero raw link syntax in any resulting document.

**Acceptance Scenarios**:

1. **Given** `Check the [runbook](rb) before deploying.`, **When** a push
   changes the URL to `rb2` AND swaps `Check` → `Consult`, **Then** both
   edits apply and the re-export equals the pushed file — the word swap is
   not dropped.
2. **Given** any block where at least one hunk classifies structural,
   **When** the block is rebuilt, **Then** the rebuild source string is
   composed from ALL of that block's hunks (structural, text, and
   reconcile alike), and no other lane separately applies or skips a hunk
   of that block.
3. **Given** a pushed edit that inserts a lone `[` or `]` (e.g. turning a
   word into a link, or adding a bracketed note), **When** the hunk is
   classified, **Then** unbalanced bracket syntax counts as inline mark
   syntax — it can never ride the plain-text lane into a dropped edit or
   an unbalanced rebuild.
4. **Given** the full fuzz corpus of link-bearing edits, **When** each is
   pushed, **Then** no resulting document contains raw `](` or stray
   escaped brackets outside a well-formed link.

---

### User Story 3 - Receipts report what happened, not what was planned (Priority: P2)

An agent pushes a file and reads the receipt. The operation counts and
per-block change list describe what the engine actually did to the
document. A new `converged` field states whether the applied result
matches the pushed file. When a push takes no effective action over a
document that does not match the file — a net-zero apply, or an
"already applied" noop over a diverged doc — the receipt says
`converged: false` instead of a clean success, so the agent knows to
re-pull and repair rather than trust and move on.

**Why this priority**: Honest receipts are what make the other two fixes
verifiable — and the backstop for any apply defect not yet discovered.
It depends on the apply layer exposing per-op outcomes, so it follows the
P1 stories.

**Independent Test**: Drive the engine through scenarios where apply
skips or neutralizes work (structural claim over a planned text block,
net-zero delete+reinsert, byte-identical re-push over a diverged doc) and
assert the receipt's `operations`, `blocksChanged`, and `converged`
reflect the actual outcome.

**Acceptance Scenarios**:

1. **Given** any completed sync push, **When** the receipt is built,
   **Then** `operations` and `blocksChanged` derive from apply results:
   an operation the apply layer skipped or did not perform is never
   reported as applied.
2. **Given** a push whose applied result serializes byte-identically to
   the pushed canonical markdown, **When** the receipt is built, **Then**
   `converged: true`.
3. **Given** a push that applies as a net-zero op sequence (document
   byte-identical to the baseline, not the pushed file), **When** the
   receipt is built, **Then** `converged: false` — with the op counts
   reflecting what actually happened, never a fabricated change list.
4. **Given** a re-push of a byte-identical file against the same baseline
   (idempotency short-circuit) over a document that does NOT match the
   pushed file, **When** the noop receipt is built, **Then** it carries
   `converged: false` — `noop: true` alone can no longer certify success.
5. **Given** a dry run (`dryRun=true`), **When** the preview receipt is
   built, **Then** it carries the same `converged` determination a real
   push would (computed without touching the live document), per 054's
   preview-parity rule.
6. **Given** existing 054 consumers, **When** they read a 056 receipt,
   **Then** every field they rely on (docId, mode, noop, clock, markdown,
   overlaps, images, operation aggregates, blocksChanged, staleness
   quartet, dryRun marker) is present with unchanged meaning — `converged`
   is purely additive, and the re-export `markdown` field remains the
   ground-truth next baseline it already is.

---

### User Story 4 - A repair push always works (Priority: P2)

Whatever state a document is in — including states corrupted by the old
engine — an agent can re-export it, edit the export to the desired
content, and push against that fresh baseline; the document converges to
the desired state in that one push. This is the core promise the field
agent lost: sync is self-repairing, and `mode=replace` is never the only
exit.

**Why this priority**: Convergence-under-repair is the property that makes
every other failure recoverable. It is largely a consequence of fixing
Bugs A–C, but it is specified (and tested) as its own property because it
is the user-facing promise.

**Independent Test**: For every corpus scenario, take the (possibly
wrong) post-push document, re-export it as a fresh baseline, push the
desired markdown, and assert convergence in one push — no stuck loops, no
receipt claiming ops while the document stays unchanged.

**Acceptance Scenarios**:

1. **Given** any document state reachable by the engine and any desired
   markdown expressible in the supported dialect, **When** the desired
   markdown is pushed against a freshly re-exported baseline of that
   state, **Then** the post-apply serialization equals the pushed
   canonical markdown (`converged: true`).
2. **Given** a repair loop that pushes the same desired file repeatedly,
   **When** a push produces no document change and the document still
   does not match the file, **Then** the receipt says `converged: false`
   with honest (zero-effect) op counts — the "reports ops, applies
   nothing, forever" failure mode is impossible.

---

### Edge Cases

- **Insertion at a boundary between two adjacent mapped runs** (plain text
  directly followed by more mapped text, no syntax between): the existing
  left-preference rule resolves it (continue the preceding run) — pinned,
  not changed. The following-run rule applies only where the insertion
  offset is a following run's mapped start and no run's mapped end equals
  the offset (i.e. the insertion sits beyond closing syntax).
- **Insertion adjacent to opening syntax** (word typed right before `[` or
  `**`): the offset falls at the preceding run's mapped end (→ left rule,
  plain text) or inside syntax (→ structural). Neither may inherit the
  following mark.
- **Insertion at the start of a block whose first run is marked** (word
  before a leading link): the offset lands on syntax, not a run → the hunk
  is structural and the block rebuilds; the applied word must not carry
  the link mark.
- **A block whose hunks span all three lanes** (reconcile-worthy mark
  change + plain text edit + structural URL edit): one structural rebuild
  from all hunks; the receipt reports that block once, as structural.
- **Edge-block insertion** (pure whole-block insertion at a block's
  leading/trailing edge): still inserts AROUND the block preserving its
  identity — the fold-together rule applies to edits *of* a block, not to
  insertions *beside* it.
- **Forced (aligner-emitted) whole-block hunks from 055**: already carry
  their block's full new content by construction; the fold-together rule
  must not double-apply or re-classify them.
- **Delete-only hunks and hunks deleting text that includes bracket
  syntax**: deletion that unbalances the remaining markdown of the block
  must classify structural, same as unbalanced insertion.
- **Net-zero after the fix**: with plan-side inheritance the known
  net-zero shape converges; `converged` remains as the backstop for any
  residual net-zero path, never reporting it as success.
- **Concurrent live edits during a push**: `converged` speaks to the
  engine's own application fidelity (fork result vs pushed file), not to
  concurrency; live divergence remains the province of the 054 staleness
  fields and overlap flags. See clarifications ledger RBD-056-1.
- **Canonical-equal noop** (pushed file matches baseline exactly): stays a
  noop; trivially `converged: true` (nothing to apply), with staleness
  fields still reporting any doc-side movement.

## Requirements *(mandatory)*

### Functional Requirements

**Plan-side mark inheritance (Bug A)**

- **FR-001 (Marks are decided at plan time)**: The mark attribution of
  every planned insertion MUST be decided during planning and recorded in
  the plan: the classifier records which mapped run resolved the
  insertion point, and apply MUST format the inserted text with that
  run's marks. Apply MUST NOT probe the live/fork document's neighboring
  characters to choose marks (the `at - 1` anchor probe is removed).
- **FR-002 (Following-run rule)**: An insertion whose markdown offset
  equals a following run's mapped start — i.e. the insertion is
  right-adjacent to closing mark syntax, outside the preceding mark —
  MUST take the FOLLOWING run's attributes. A comma after a link is plain
  text; a character appended inside the link text (offset within or at
  the boundary of the link's mapped run) keeps the link.
- **FR-003 (Left preference preserved)**: The existing left-preference
  branch (insertion offset equal to a preceding run's mapped end) MUST be
  preserved with unchanged semantics — typing at the end of a styled span
  continues the span. This branch is load-bearing for normal typing;
  056 changes which run apply *honors*, not how the classifier orders its
  resolution (left run first, following run second, structural last).

**A block's hunks travel together (Bugs B and C)**

- **FR-004 (Fold-together rule)**: When any hunk of a block classifies
  structural, ALL of that block's hunks — text, reconcile, and structural
  alike — MUST fold into that block's single structural rebuild, and the
  rebuild source string MUST be composed from all of them. No lane may
  separately apply, and no skip path may silently discard, a hunk of a
  structurally rebuilt block.
- **FR-005 (Unbalanced brackets are mark syntax)**: Hunk classification
  MUST treat unbalanced square-bracket syntax (a lone `[` or `]` in the
  inserted text, or a deletion that unbalances the block's remaining
  brackets) as inline mark syntax, so such hunks can never ride the
  plain-text lane.
- **FR-006 (No raw syntax leaks)**: A structural rebuild MUST parse the
  block's complete intended new content; the engine MUST NOT produce
  documents containing raw link syntax (`](`, stray unmatched brackets
  from a partial rebuild) as literal text where the pushed file contained
  a well-formed construct.

**Honest receipts**

- **FR-007 (Receipts derive from apply results)**: The apply layer MUST
  report per-operation outcomes (applied / skipped), and the receipt's
  `operations` and `blocksChanged` MUST derive from those outcomes — an
  operation apply skipped (unresolvable block node, structural claim,
  empty parse, or any future skip path) MUST NOT be reported as applied.
  Existing aggregate keys keep their names and meaning ("work performed"),
  now guaranteed truthful; skipped work is visible per RBD-056-2.
- **FR-008 (The `converged` field)**: Every `mode=sync` receipt — applied,
  noop, and dry-run alike — MUST carry `converged`: whether the engine's
  post-apply result serializes byte-identically to the pushed canonical
  markdown (comparison basis per RBD-056-1). `converged: true` MUST imply
  the pushed file's content was fully realized by the engine.
- **FR-009 (Net-zero honesty)**: A push that applies as a net-zero op
  sequence — the document ends byte-identical to the baseline rather than
  the pushed file — MUST return `converged: false` and MUST NOT fabricate
  a change report claiming the pushed edits landed.
- **FR-010 (Noop-over-divergence honesty)**: The idempotency
  short-circuit (byte-identical re-push, "already applied") MUST return
  `converged: false` whenever the engine's result for that push does not
  match the pushed canonical markdown. `noop: true` with `converged:
  false` is the designed signal for "your file and the doc disagree;
  re-pull and repair". A noop over a genuinely matching state returns
  `converged: true`.
- **FR-011 (Receipt compatibility)**: All receipt fields defined by 054
  (FR-001, FR-009, FR-011 of `specs/054-sync-feedback-hardening/spec.md`)
  MUST remain present with unchanged names and semantics: docId, mode,
  noop, clock, markdown (re-export ground truth — unchanged), overlaps,
  images, operation aggregates, blocksChanged (same `text | reconcile |
  structural` vocabulary), baselineClock/currentClock/clockGap/
  docChangedSinceBaseline, and the dry-run marker rules. `converged` and
  any skipped-work reporting are additive.
- **FR-012 (Dry-run parity)**: `dryRun=true` MUST compute and return
  `converged` and the apply-derived report exactly as a real push would,
  still without any durable write — preserving 054's preview-parity and
  "leaves no trace" guarantees.

**Convergence properties and non-regression**

- **FR-013 (Corpus convergence)**: For every scenario in the verification
  corpus (the shapes in `repro1.js`–`repro4.js`: boundary insertions at
  link/bold edges, mixed URL+text edits, unwrap/move/linkify/add-link,
  multi-block variants, bracket fuzz), a single push against the current
  baseline MUST converge — post-apply serialization equals pushed
  canonical markdown — restoring the design's push ≡ offline-client
  property for the corpus.
- **FR-014 (Repair-push convergence)**: A push of desired content against
  a FRESHLY re-exported baseline MUST converge in that one push, for any
  engine-reachable document state — including states corrupted by the
  pre-056 engine. The "stuck repair loop" (receipt reports ops, document
  never changes, forever) MUST be impossible: any such no-progress push
  reports `converged: false` with zero-effect op counts.
- **FR-015 (Regression seeds committed)**: The repro corpus MUST be
  encoded as committed automated tests (the scratchpad scripts are
  session-ephemeral); the tests MUST assert convergence AND receipt
  honesty (op counts, `converged`) per scenario, at the DB-free replay
  layer the investigation used, plus route-level coverage for the noop
  and dry-run receipt cases.
- **FR-016 (055 invariants untouched)**: The block-alignment pre-pass and
  its invariants — FR-002 no-cross-block-splices, forced whole-block
  hunks, similarity semantics, size parity — are not modified. 056
  changes classification of *within-block* hunks (FR-005) and the apply
  layer only; forced hunks still skip classification.
- **FR-017 (Round-trip invariant preserved)**: `import(export(doc))`
  remains a no-op; an unchanged exported file still syncs as a
  canonical-equal noop (now with `converged: true`).

### Key Entities

- **Mapped run**: a contiguous span of emitted markdown text tied to one
  document text node with one mark set, recorded by the serializer source
  map. 056 makes the run the *authority* for inserted-text marks.
- **Hunk**: one contiguous edit from the baseline-vs-pushed diff. Gains a
  plan-recorded resolved run (for insertions) and an honest classification
  (unbalanced brackets = mark syntax).
- **Push plan**: the classified lanes (text blocks / reconcile blocks /
  structural). 056 pins the fold-together rule: a block appears in at
  most one lane.
- **Apply result**: new — the per-operation applied/skipped record the
  apply layer returns; the sole source for receipt op reporting.
- **Sync receipt**: the `mode=sync` response. Gains `converged`; all 054
  fields retained; `markdown` re-export remains the next-baseline ground
  truth.
- **Verification corpus**: the ~40 replay scenarios from the field
  investigation (repro1–repro4), committed as regression tests.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the verification-corpus scenarios converge on the
  first push (post-apply serialization byte-equal to the pushed canonical
  markdown). Before 056, scenarios in every one of the four repro
  families failed.
- **SC-002**: 100% of corpus scenarios converge in exactly one
  fresh-baseline repair push from any corrupted state; zero scenarios
  exhibit a stuck repair loop across the whole suite.
- **SC-003**: Across the entire test suite, zero receipts report an
  operation or changed block that apply did not perform, and every push
  whose result does not match the pushed file returns `converged: false`
  — including net-zero applies and already-applied noops over diverged
  docs.
- **SC-004**: Zero documents produced by the corpus (including the fuzz
  family) contain raw link syntax (`](`, unmatched brackets) as literal
  text where the pushed file had a well-formed construct.
- **SC-005**: An agent can determine from a single sync receipt alone —
  no re-export-and-diff round trip — whether its push fully took effect.
- **SC-006**: All existing 054 and 055 test suites pass unchanged
  (receipt-field compatibility, alignment invariants, round-trip,
  dry-run trace-freedom); previously written baseline files remain valid
  push inputs.

## Assumptions

- All unanswered product decisions are resolved by defaults recorded as
  **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11)** in this
  feature's `clarifications-needed.md` (Constitution VI); the material
  ones are: `converged` compares the engine's fork-side post-apply
  serialization against the pushed canonical markdown (RBD-056-1);
  skipped work is reported additively without changing existing aggregate
  keys (RBD-056-2); no in-engine auto-retry or fallback on
  `converged: false` (RBD-056-4); classifier resolution order stays
  left-run → following-run → structural (RBD-056-5); dry runs carry
  `converged` (RBD-056-6); a folded block reports once, as `structural`
  (RBD-056-7).
- The `converged` comparison reuses the engine's existing canonical
  serialization (squire flavor for the internal comparison, per the
  canonicalization the diff already runs); no new dialect is introduced.
- The verification corpus is authoritative for "the field failures": the
  investigation reproduced all reported defects at the replay layer with
  zero concurrency, so DB-free replay tests plus targeted route-level
  receipt tests are sufficient evidence of the fix; no new live-doc
  machinery is needed.
- 054's `blocksChanged` excerpt/cap rules and 055's alignment are taken
  as frozen upstream contracts; 056 builds on the merged state of both.
- `server/markdown-sync.js` contains NUL bytes; tooling that greps it
  must use binary-tolerant search (`grep -a`) or direct reads (known
  repo hazard, noted for implementers).

## Out of Scope

- **Read-path / live-doc consistency (feature 057)**: torn reads,
  bindState/fan-out ordering, livelock, and any defect involving the
  live document's loading or replication path belong to the sibling
  feature being specced in parallel as
  `specs/057-live-doc-consistency`. 056 is strictly the push apply
  layer (fork-side planning/apply) and the receipt built from it.
- Concurrency semantics: overlap detection, staleness strictness, and
  the CRDT interleave outcomes table are unchanged (054/design §2.4.1).
- In-engine repair automation: no auto-retry, no fallback to whole-block
  or whole-doc replace on `converged: false` (RBD-056-4); clients repair
  via fresh-baseline pushes, which FR-014 makes reliable.
- `mode=append` / `mode=replace` / create imports: their receipts and
  behavior are untouched; `converged` is a `mode=sync` field.
- Block move/identity detection, similarity-threshold tuning, and other
  055 follow-ons.
- Serializer/parser dialect changes (ordered-list numbering etc. shipped
  in 054; nothing new here).
- MCP tool-surface or documentation-page changes beyond what the receipt
  addition itself requires (teaching surfaces were 054's FR-015 scope).
