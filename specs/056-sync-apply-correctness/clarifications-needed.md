# Clarifications Ledger: 056-sync-apply-correctness

Per Constitution VI, unanswered product decisions get the best default,
recorded here — work never blocks on the maintainer, and nothing is decided
silently. All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized,
2026-08-11)** unless later overturned.

---

## RBD-056-1 — What `converged` compares

**Question**: The amendment defines `converged` as "the fork's post-apply
serialization compared to the pushed canonical markdown", but also demands
`converged: false` for "an already-applied stale-baseline noop over a
diverged doc". Fork-side comparison and live-doc comparison are different
measurements — which one is `converged`?

**Why it matters**: A live-doc comparison would report `false` whenever
anyone typed concurrently, conflating application fidelity with
concurrency — making `converged` noisy and useless for the repair loop it
exists to serve. A fork-side comparison measures exactly what the engine
did with the push.

**Default chosen**: Fork-side, per the amendment's own definition:
`converged` = (serialization of the engine's fork after all planned ops
are applied) byte-equals the pushed canonical markdown. The paths without
a fresh apply are defined consistently: the canonical-equal noop (pushed
file == baseline) is trivially `true`; the already-applied idempotency
noop compares the fork result its (re)computed plan produced — which is
exactly what reproduces `false` in the field-reported S1 scenario, since
the same buggy-or-not plan is what the doc already contains.

**Rationale**: This satisfies every clause of the amendment for the
failure class that exists: a diverged doc under an already-applied noop is
diverged precisely because the original apply did not realize the pushed
content, and the recomputed fork shows that. When apply is correct and the
doc diverged only via concurrent edits, `converged: true` +
`docChangedSinceBaseline: true` (054) is the honest pair of signals —
divergence-by-concurrency is staleness's job, not `converged`'s. If Sam
intended a live-doc comparison, only the noop branch changes; flagged as
design gap 1.

---

## RBD-056-2 — How skipped work appears on the receipt

**Question**: FR-007 makes `operations`/`blocksChanged` derive from apply
results, but 054 FR-011 freezes the existing aggregate keys
(`textHunks`, `structuralHunks`) for compatibility. Where does skipped
work go?

**Why it matters**: Dropping skipped ops silently would repeat the
original sin (receipt hides a gap); renaming or reshaping the aggregates
would break 054's compatibility promise.

**Default chosen**: The existing keys keep their names and now count only
work actually performed. Skipped work is reported additively: an
`operations.skipped` count (0 on healthy pushes), and `blocksChanged`
lists only blocks apply actually changed. No entry-level "skipped" rows in
`blocksChanged` — `converged: false` plus the skipped count is the alarm;
the re-export is the ground truth for what the doc holds.

**Rationale**: Keeps 054 consumers parsing unchanged shapes, makes healthy
receipts look identical to today's, and puts the anomaly signal in two
places (skipped > 0, converged false) that cannot be confused with
success. Post-056 the known skip paths are designed out (fold-together
rule), so `skipped` existing at all is defense in depth for future paths.

---

## RBD-056-3 — Net-zero detection mechanism

**Question**: Must the engine specifically detect "net-zero op sequence"
(delete+reinsert leaving the doc byte-identical), or is the serialization
comparison enough?

**Why it matters**: A dedicated detector would add op-level bookkeeping
for a case the fixes largely eliminate.

**Default chosen**: No dedicated net-zero detector. The `converged`
serialization comparison is the backstop: any net-zero application of a
non-noop push yields fork == baseline != pushed → `converged: false`,
which FR-009 requires. Op counts still report what apply did (the ops ran;
they were just mutually cancelling), which is the truth.

**Rationale**: One mechanism (byte comparison) covers every net-zero shape
including ones not yet imagined, with zero new bookkeeping. The known
net-zero shape (Bug A's delete+reinsert) converges after FR-001/002
anyway.

---

## RBD-056-4 — Behavior on `converged: false`

**Question**: When a real push ends `converged: false`, should the engine
retry, degrade to a whole-block/whole-doc replace, or roll back?

**Why it matters**: Auto-repair machinery is new engine behavior with its
own failure modes (a rollback path would need un-applying a stored CRDT
update — not a thing in this model).

**Default chosen**: None of the above. The push stands as applied (the
CRDT update is stored; the receipt is honest about it); the engine adds no
retry, fallback, or rollback. The client-side remedy is a fresh-baseline
repair push, which FR-014 guarantees converges.

**Rationale**: The amendment ratifies honest receipts + restored
convergence, not self-healing. With FR-014, one repair push always
suffices, so automation buys nothing and risks masking regressions the
`converged` field exists to surface. Follow-on if field data disagrees.

---

## RBD-056-5 — Resolution precedence for insertion points

**Question**: FR-002 adds the following-run rule; the design also pins the
left-preference branch. In what order do the rules resolve, and what about
insertions adjacent to OPENING syntax or at a marked block start (the
amendment only names closing syntax)?

**Why it matters**: Ambiguous precedence would make mark inheritance
nondeterministic at run boundaries — the exact disease being cured.

**Default chosen**: Keep the classifier's existing resolution order:
(1) offset strictly inside a run → that run; (2) offset at a preceding
run's mapped end → that (left) run; (3) offset at a following run's
mapped start → that (following) run; (4) otherwise (inside syntax,
between blocks) → structural. 056 changes only that apply now honors the
recorded run instead of probing neighbors. The geometry of the source map
makes the rules non-conflicting: insertion beyond closing syntax can only
match rule 3 (the left mark's run ends before its closing syntax);
insertion before opening syntax matches rule 2 (plain left run) or falls
to structural (block-leading mark), and the structural rebuild parses the
correct marks from the markdown itself.

**Rationale**: Matches the amendment's "the left-preference branch stays"
verbatim, covers the opening-syntax cases the amendment is silent on
without new rules, and is exactly what the existing repro corpus pins
(P4 word-before-link, block-leading-link edge case).

---

## RBD-056-6 — Dry runs carry `converged`

**Question**: The amendment says "every sync receipt gains converged" but
054 defined dry-run receipts before `converged` existed. Do previews get
it?

**Why it matters**: 054 FR-006 promises the preview is "computed and
returned exactly as a real push" — a preview that cannot predict
non-convergence would hide exactly what a cautious agent dry-runs to
learn.

**Default chosen**: Yes. `converged` is computed from the fork (RBD-056-1
makes it fork-side by definition, so it needs no durable write) and
returned on dry-run receipts identically to real pushes. Dry-run
trace-freedom (054 SC-003) is unaffected.

**Rationale**: Preview parity is already a ratified 054 principle;
fork-side computation makes honoring it free.

---

## RBD-056-7 — Change-report shape for folded blocks

**Question**: When FR-004 folds a block's text/reconcile hunks into a
structural rebuild, how does that block appear in `blocksChanged`?

**Why it matters**: 054/055 pinned the op-kind vocabulary
(`text | reconcile | structural`); double-reporting a folded block (once
per lane) would inflate counts and confuse verification tooling.

**Default chosen**: A folded block appears exactly once, with kind
`structural` (the op actually performed). Its former text/reconcile hunks
are not separately listed and count toward `structuralHunks` (as part of
the one rebuild), not `textHunks`.

**Rationale**: The report describes operations performed (FR-007); after
folding there is one operation. Vocabulary unchanged, counts truthful,
one block = at most one entry — the invariant verification tooling wants.

---

# Design gaps flagged (Constitution VI)

1. **`converged` comparison basis under the already-applied noop**
   (RBD-056-1): the amendment's fork-side definition and its
   "noop over a diverged doc → false" clause coincide for the reproduced
   failure class, but diverge for apply-correct + concurrently-edited
   docs (fork-side says `true` + staleness flags; live-doc-side would say
   `false`). Default is fork-side; if Sam wants live-doc semantics, only
   the noop branch changes and the design doc should say "current
   document serialization" explicitly.
2. **Opening-syntax insertions unaddressed in the amendment**: the
   ratified text names only "right-adjacent to closing syntax". The
   existing left-rule + structural fallback covers the opening-syntax and
   block-leading-mark cases (RBD-056-5), but the design doc could state
   the full precedence so a future reader does not infer a symmetric
   "preceding run's attrs at opening syntax" rule that does not exist.
3. **Skipped-work receipt shape not specified** (RBD-056-2): the
   amendment says receipts "derive from apply results" but not how
   skipped work surfaces against 054's frozen aggregate keys. Default:
   additive `skipped` count, applied-only aggregates.
4. **Repro corpus is session-ephemeral**: the verified repro scripts live
   in a scratchpad directory that does not survive the session. FR-015
   makes committing them as tests a requirement of this feature, not an
   optional nicety — flagged so implement does not treat the scratchpad
   as durable ground truth.
5. **057 boundary**: the same field report's torn-read/livelock items are
   explicitly NOT covered here; they are the sibling feature
   `specs/057-live-doc-consistency` (read path / bindState / fan-out).
   The two specs share no requirements; if 057 lands receipt changes,
   reconcile at plan/merge time against FR-011's additive-only rule.
