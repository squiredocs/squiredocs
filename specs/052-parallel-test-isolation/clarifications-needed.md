# Clarifications & Decisions Ledger — 052-parallel-test-isolation

Decisions made without live maintainer input during parallel spec authoring
(2026-08-04). Nothing here was decided silently: each entry records the
question, why it matters, the chosen default, and the rationale. Sam may
overturn any entry.

**Not in this ledger**: D1–D4 from the design doc's Open Decisions table. Sam
ratified all four at their stated defaults on 2026-08-04 (D1 Principle II
amendment proceeds as written; D2 perf guards stay in the default run; D3
one-run-at-a-time rule kept, no per-run nonce; D4 maxWorkers 50% locally,
explicit maxWorkers in CI). They are spec'd as first-class requirements
(FR-009, FR-012, FR-013, FR-014) and are not re-opened here.

---

## A. Ratified-by-default decisions (design-doc silences)

### RBD-052-1 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)** — Template naming derives from the base URL, per base

- **Question**: the design names the template `collab_test_db_template` and
  says an explicit `DATABASE_URL` "becomes a base URL the helper suffixes the
  same way" — but it is silent on which **template** a run with an external
  base uses. One global template, or one derived from the base?
- **Why it matters**: pipeline worktree agents run test suites **concurrently**
  with per-agent base URLs (the-pipeline SKILL.md). If all invocations shared
  one literal `collab_test_db_template`, two concurrent worktree runs would
  race on creating/migrating/copying-from the same template (Postgres forbids
  `CREATE DATABASE ... TEMPLATE x` while `x` has active connections), breaking
  the worktree convention the design explicitly says must keep working.
- **Default chosen**: the template name is derived from the base database name
  (`<base_dbname>_template`), exactly as the per-worker names are
  (`<base_dbname>_w<N>`). The design's `collab_test_db_template` is then simply
  the derived name for the default base. Each per-agent base yields a disjoint
  {template, workers} family, so concurrent worktree invocations are isolated
  by construction on the Postgres side.
- **Rationale**: it is the only reading that satisfies both design statements
  at once ("suffixes the same way" + worktree convention keeps working), and it
  removes a race instead of adding a rule.

### RBD-052-2 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)** — Redis mapping is logical DB = JEST_WORKER_ID; tests never use DB 0

- **Question**: the design says "assign each worker its own logical database
  from JEST_WORKER_ID" but not the actual mapping (0-based? 1-based? offset?).
- **Why it matters**: DB 0 is where every non-test consumer already lives —
  including a dev server sharing the same Redis (a real environment here: the
  shared-Redis finding of 2026-08-02, and Minikube's shared Redis instance).
  If worker 1 mapped to DB 0, serial test runs would keep colliding with the
  dev server's keys exactly as they can today.
- **Default chosen**: logical DB = `JEST_WORKER_ID` verbatim (worker 1 → DB 1,
  … worker 15 → DB 15). Tests therefore never touch DB 0, which stays the
  exclusive home of non-test consumers. This is also what makes the cap 15
  workers (not 16), matching the design's stated cap.
- **Rationale**: zero-arithmetic mapping, consistent with the `_w<N>` database
  naming, and it turns the serial run's Redis isolation from the dev server
  into a free side benefit. The design's own "caps workers at 15" arithmetic
  only holds if DB 0 is excluded, so this reading is implied.

### RBD-052-3 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)** — The 15-worker cap is enforced by failing fast

- **Question**: the design states the cap ("16 logical databases, which caps
  workers at 15") but not what happens if a run is configured beyond it.
- **Why it matters**: a 16th worker would silently wrap or share a logical
  database, reintroducing exactly the cross-talk this feature exists to
  eliminate — and it would look like a mystery flake, the worst failure mode.
- **Default chosen**: spec'd as FR-008 — if the effective worker count exceeds
  15, the run fails fast at startup with a clear error naming the cap and the
  fix. Never silently share, never silently clamp.
- **Rationale**: the design calls the cap "far above the useful worker count on
  our runners", so the guard is a tripwire that should never fire; a loud
  tripwire costs nothing, a silent one costs a debugging campaign.

### RBD-052-4 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)** — Amendment coherence extends to secondary references

- **Question**: design 2.3 gives replacement text for Principle II only. The
  constitution's Development Workflow section also says "affected tests pass
  (serially for backend)", and the-pipeline SKILL.md's worktree guidance says
  "Within one DB, backend tests are serial-only (--runInBand is already wired
  in; don't defeat it)". The design is silent on both.
- **Why it matters**: this project treats stale governing text as a defect
  (Constitution Principle I; agents take docs literally). Leaving either
  reference would have the constitution contradict itself and the pipeline
  skill instruct agents to defeat the new default.
- **Default chosen**: spec'd as FR-011/SC-007 — the same commit that amends
  Principle II updates the Development Workflow gate wording and the pipeline
  skill's worktree test guidance to match the new invariant (per-agent base
  URL still required; serial no longer mandated). Principle II itself uses the
  2.3 text **verbatim**; only the secondary references get coherence edits.
- **Rationale**: mechanical consequence of the ratified amendment plus
  Principle I's docs-must-track-reality rule; not a new policy decision.

### RBD-052-5 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)** — Template freshness is an invariant; refresh mechanics are a plan choice

- **Question**: the design says globalSetup "creates and migrates" the
  template, silent on whether an existing template from a prior run is reused
  (migrate-forward, like today's `collab_test_db` handling) or dropped and
  rebuilt each run.
- **Why it matters**: a stale template (e.g. from a run on an older branch, or
  a half-applied migration after a crash) would be copied into every worker
  database and fail all 254 suites at once with schema errors.
- **Default chosen**: the spec fixes the **invariant** (FR-005): per-worker
  databases are always created from a template that is fully migrated at run
  start, and a worker can never receive a database at the wrong schema state.
  Whether that is achieved by migrate-forward-then-copy (cheapest, mirrors
  today's globalSetup) or drop-and-rebuild (most deterministic) is left to the
  plan phase, which must also handle the crashed-mid-migration case loudly.
- **Rationale**: the observable behavior is the invariant; the refresh
  mechanism is an implementation trade (run time vs determinism) the plan can
  measure. Note for the plan: the phantom-pgmigrations guard lives in
  `script/migrate.js` (auto-memory `rolledback-008-migration-cruft`) and runs
  wherever `npm run migrate` runs, so template migration inherits it.

### RBD-052-6 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)** — The Principle II amendment is a MINOR bump (1.2.0 → 1.3.0)

- **Added at plan/analyze time (2026-08-04)**, not during spec authoring: the
  planning pass had to name a version number in a task and found the level
  genuinely arguable, so it is recorded here rather than asserted silently.
- **Question**: the design (§2.3) and the spec (FR-009) both say the amendment
  follows the constitution's Governance section, but neither states the
  semantic-version level. Governance defines MAJOR as "principle
  removal/redefinition", MINOR as "new principle or materially expanded
  guidance", PATCH as "clarification/wording".
- **Why it matters**: Principle II is not being removed, but one of its
  normative clauses is being replaced with a different rule. A reader could
  defensibly call that a redefinition (MAJOR, → 2.0.0) or materially changed
  guidance (MINOR, → 1.3.0). Getting it wrong is a governance defect in the
  document whose whole job is to be authoritative.
- **Default chosen**: **MINOR, 1.2.0 → 1.3.0.** Principle II keeps its number,
  its name ("Test-Backed Changes") and its thrust: every behavioral change is
  test-backed, Jest for backend and Vitest for frontend, format changes extend
  the round-trip suite. Only the trailing execution-model constraint changes,
  and it changes to a *stronger* invariant rather than a weaker one. The
  principle is amended, not redefined.
- **Rationale**: the closest precedent in this document is its own 1.1.0 →
  1.2.0 bump, which added an entire new principle (VII) and was MINOR. Treating
  a single-clause replacement inside an existing principle as MAJOR would make
  that precedent incoherent. Recorded so Sam can overturn to 2.0.0 in one edit
  if he reads "redefinition" more broadly — the amendment text itself is
  unaffected either way.

---

## B. Noted gaps (flagged, no decision required)

### N-052-A — Cross-invocation Redis isolation exists only by rule (D3), not by mechanism

Two concurrent whole invocations both map worker N to Redis logical DB N —
per-agent `DATABASE_URL` bases give worktree agents disjoint **Postgres**
families, but there is no per-agent Redis analog in the ratified design.
D3 (ratified: keep the one-run-at-a-time rule, no nonce) covers this; it is
recorded here only so nobody mistakes the worktree Postgres isolation for
whole-stack isolation. Materially, this is no worse than today, where every
run and the dev server all share DB 0 — and under RBD-052-2 tests at least
leave DB 0. If concurrent worktree **test** runs ever become routine rather
than exceptional, a per-agent `REDIS_DB` offset convention would be the
follow-on ask; it is out of scope here per D3.

### N-052-B — The CI workflow this feature edits does not exist yet

`.github/workflows/test.yml` is still the pre-051 single job at spec time.
The spec (Assumptions) targets the post-051 split backend job per the design's
Train ordering; the plan for 052 must be written/validated against 051's
merged shape, and 052's implementation is queued behind 050 and 051 in the
merge order for exactly this reason.
