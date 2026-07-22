# M2 exit gate record (FR-034, SC-007)

M2's exit is **twofold** and both parts must be recorded here before any M3 work
begins and before anything is published:

- **(a)** a clean full-matrix run (all 11 cells match their profiles in one run,
  all model legs completed) — archived transcripts + per-cell grades.
- **(b)** Sam's HITL sign-off on **mechanics AND tone**, from the production
  self-test (M1 single-account reset + `selftest@example.com` + real browser
  against prod).

M3 stays blocked until BOTH are recorded. This gate is HITL by definition — part
(b) is not scriptable.

## Part (a) — clean full-matrix run

**Status: NOT YET RECORDED (see implementation report for the current per-cell
matrix state).**

Produce with:

```bash
# dev pod, dev server up on the target with ENABLE_DEV_ENDPOINTS=1, ANTHROPIC_API_KEY set
node test/first-run/matrix-runner.mjs --server http://localhost:3001
```

A clean run exits 0 with `11/11 cells match their profile` and archives
transcripts + grades under `test/first-run/matrix-archive/run-<stamp>/`. Record
here when achieved:

- Date/stamp:
- Archive path: `test/first-run/matrix-archive/run-________`
- Per-cell result: 11/11 PASS
- Runner exit code: 0

## Part (b) — Sam's production self-test sign-off

**Status: NOT YET RECORDED — owed to Sam (HITL).**

Procedure (design "Human self-test path"):

1. Reset `selftest@example.com` to first-run via the production single-account
   reset (M1).
2. In a real Claude Code on the laptop, install the plugin and run
   `/squire:onboard`; sign in as that account through a real browser against
   production; walk the flow as a genuine new user.
3. Judge **mechanics** (connect → find-spec → byte-channel sync → doc-URL payoff
   → loop) AND **tone** (the shared content + consent-page copy in the
   honest-confident voice; "Squire Docs" throughout).

Record on approval:

- Date:
- Scope: mechanics AND tone
- Transcript / notes references:
- Sam's decision: ____ (approved / changes requested)

## Gate status

- [ ] (a) clean full-matrix run recorded
- [ ] (b) Sam's mechanics-and-tone sign-off recorded
- [ ] → M2 EXIT MET; M3 unblocked

Until every box is checked, nothing from this feature is published and M3 does
not begin (SC-007). The M3 obligations handed forward are in `promotion-notes.md`.
