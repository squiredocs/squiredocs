# Quickstart / Validation Guide: Plugin Logic (Plugin M2)

How to validate the M2 deliverables. Runs in the Linux dev pod (rehearsals are pod-only — macOS Keychain caveat, 029 FR-024). Prerequisites: dev server up with `ENABLE_DEV_ENDPOINTS=1`; `ANTHROPIC_API_KEY` set for any model leg. Paths are repo-relative from `/local-dev`.

## 1. Canonical content authored + contract cross-check (US1, SC-006)

- Files exist: `distribution/shared/skill.md`, `distribution/shared/onboard.md`.
- Structured review: every design-fixed element present (entry states; four walkthrough steps in order; command-availability caveat; four failure-ladder rungs; five moves; the loop + byte-channel + token rules) and nothing contradicting `design/agent-surface-mcp.md`.
- Documented cross-check against the Agent Surface contract records zero contradictions (SC-006). Product name "Squire Docs" throughout; no bare "Squire".

## 2. Bundle assembly + agreement check (US2, SC-004)

```bash
node test/first-run/assemble-bundle.mjs                 # generates the bundle from distribution/shared/
node test/first-run/check-bundle-agreement.mjs          # exits 0 when bundle matches shared/
```

- Expected: assembled bundle carries do-not-hand-edit headers; `distribution/shared/` byte-identical before/after (unmutated).
- Drift check: hand-edit a generated `skills/squire/SKILL.md` → `check-bundle-agreement.mjs` exits non-zero (SC-004). `distribution/` contains only `shared/` plus the assembled artifacts — no `publish.mjs`, no mirrors, no per-channel manifests (FR-020).

## 3. Grader hardening + regression fixtures (US4, SC-003)

```bash
node test/first-run/grade-transcript.mjs test/first-run/fixtures/quote-only-transcript.jsonl      # items 5,6 FAIL
node test/first-run/grade-transcript.mjs test/first-run/fixtures/incidental-docpath.jsonl         # item 6 FAILs
node test/first-run/grade-transcript.mjs test/first-run/fixtures/genuine-performing.jsonl         # items 5,6 PASS
```

- Expected FAIL/FAIL/PASS respectively (SC-003). These fixtures run in the standard suite (deterministic — no model access needed).
- Silent-reconnect item (4) grades behaviorally: correctly-silent content passes; a ceremony block between consent and the spec step fails (RBD-10).
- Doc-URL item (6) passes only for a URL on the rehearsal-server origin corroborated by a doc-creating event; incidental `/d/…` paths fail (FR-025).

## 4. Single rehearsal against the real content (US2/US4)

```bash
node test/first-run/rehearsal-harness.mjs --server http://localhost:3001
```

- Uses the assembled bundle by default; the transcript shows the real coaching (not stub markers); structured capture includes tool-call events; `distribution/shared/` untouched.

## 5. The full sign-off matrix (US5, SC-001/002)

```bash
node test/first-run/matrix-runner.mjs --server http://localhost:3001
```

- Runs all 11 cells serially, unattended, each archiving a transcript + a per-cell grade judged against its expected-outcome profile (`contracts/matrix-cell-profile.md`).
- Always enforces `--require-claude`; with `ANTHROPIC_API_KEY` absent the runner refuses to run (non-zero) rather than skipping legs (RBD-3).
- Exit non-zero unless every cell matches its profile with its model leg completed. A "clean matrix" (SC-002) is a single full-matrix pass; archived transcripts are Sam's review material.
- Spot-checks: fresh-happy does a real sync + real doc URL; existing-never-consented leaves exactly one account (no duplicate); already-connected + token-fallback skip the walkthrough; declined/abandoned/paste-back show their rung's coaching; token-fallback's transcript never contains the token bytes; the four repo-shape cells follow the precedence order.

## 6. Consent page as a first-run surface (US3, SC-005)

```bash
npm run test:client                                     # Vitest — includes AuthorizePage first-run test
npm run test:server                                     # Jest — tier-1 consent/returnTo/provenance stay green
```

- Unauthenticated consent page shows all four framing elements (Continue-with-Google; same-click-creates-account; product line; attribution/revertibility line) — asserted by the new client test (SC-005).
- Existing consent-flow tests (`server/__tests__/auth-return-to.test.js`, `onboarding.test.js`, `integration/first-run.test.js`) stay green — mechanics unchanged (FR-024). Authenticated consent card unchanged.

## 7. Exit gate (SC-007) — HITL, not scriptable

- Record (a) a clean full-matrix run (archived transcripts + grades) and (b) Sam's production self-test sign-off on **mechanics AND tone** (M1 single-account reset + `selftest@example.com` + real browser vs prod) in the feature artifacts, with date + scope.
- M3 work does not begin, and nothing is published, before that record exists. The M3-obligations record (`promotion-notes.md`, FR-035) is handed forward.

## Standard-suite membership

Deterministic pieces join the standard suites and run on every change: grader regression fixtures, the bundle agreement check, and the consent-page client test. The model-driven matrix runner is on-demand / pre-sign-off only — NOT per-commit CI (RBD-3).
