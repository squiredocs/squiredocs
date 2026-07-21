# 027-read-only-highlights — promotion notes

## Post-merge review dispositions (2026-07-21)

Review of merge 4686854 (Fable, read-only): CRDT discipline, resolver-parity
honesty, regression risk, and worktree hygiene all CLEAN — the corpus baseline
was verified against actual pre-merge outputs and the zero-writes harness was
verified to go red when the placeholder write is reintroduced.

- HIGH-1 (FIXED same day): the checked-in esbuild sandbox bundle
  (server/mcp/sandbox/isolate-bundle.js) still embedded the pre-027
  placeholder-inserting cursor-operations — the code modify scripts actually
  execute. A script calling xpath() on a text-less element plus any tracked
  edit would have persisted the placeholder into the live doc. Fixed: bundle
  rebuilt (npm run build:sandbox-bundle) and a freshness tripwire test added
  (isolate-bundle-freshness.test.js) asserting the boundary construction is
  present and the placeholder idiom absent. Deeper fix (CI rebuild-and-compare
  freshness gate) remains a promotion item.
- LOW-2 (CORRECTED): D-5's "bare empty containers cannot occur in a persisted
  document" was overstated (sandbox raw constructors can persist them); ledger
  corrected. Behavior was already safe (zero-write, fail-observational skip;
  y-prosemirror self-repair deletes such elements client-side — pre-existing
  021-class behavior, not worsened).
- LOW-3 (NO ACTION, recorded): boundary anchors are end-associated
  (assoc=0 → resolves to type end) — under a concurrent insertion into a
  just-highlighted empty block, the highlight collapses at the block end
  rather than the start; resolveCursorPosition mixes child-index into char
  offset for that stale-anchor case. Cosmetic presence drift, equivalent to
  the old placeholder behavior; assoc=-1 is the documented option if
  start-anchoring is ever wanted.

## Owed at promotion
- CI freshness gate for the sandbox bundle (rebuild + compare vs committed).
- Manual in-editor visual check: reading an image / hr / empty paragraph
  renders a visible highlight (automated proxy: resolver-parity suite).
- Sam ratifications: D-1..D-5 (RATIFIED-BY-DEFAULT set).
