# Promotion notes — 029-first-run-test-mechanism

Relaxations and review dispositions owed at promotion (M2/M3 of the plugin
design pick these up).

## Post-merge review dispositions (2026-07-21, Fable review of 8a93a90..6807393)

Verdict: merge sound; 1 MEDIUM + 5 LOW. All security containment lenses
(dev-endpoint gating, synthetic namespace, prod reset blast radius, auth-flow
integrity, reset cascade, migration) verified clean under adversarial reading.

| Finding | Sev | Disposition |
|---|---|---|
| docs/dev.md prod-reset example used cookie auth, but REST auth reads only the Authorization header — command could never work | MEDIUM | FIXED same day: example now uses `Authorization: Bearer $ADMIN_ACCESS_TOKEN` |
| Browser-mode faucet fired notifyNewUser/notifyLogin per synthetic user — admin-inbox spam on SMTP-enabled deploys | LOW | FIXED same day: completePostAuth suppresses notifications for `isSyntheticEmail` users |
| Rehearsal harness exited 0 with the final ✓ line even when the `claude -p` leg failed/was skipped — CI wrapper would read a broken model leg as success | LOW | FIXED same day: `--require-claude` flag exits non-zero unless the model leg completed. **M2 owes**: wire `--require-claude` into whatever gate consumes rehearsals. |
| Harness `fail()` after user creation leaked the synthetic user + scratch dirs (process.exit skipped cleanup) | LOW | FIXED same day: fail() now throws; best-effort cleanup (wipe + rm) runs on every failure path |
| Client devLogin minted a fresh synthetic account for ANY valid returnTo deep link (e.g. /login?returnTo=/docs), replacing the fixed dev user session | LOW | FIXED same day: browser-mode fresh accounts only for consent-shaped returnTo (/authorize…) or explicit `fresh`; other deep links keep the fixed dev user and redirect client-side |
| Transcript grader can false-PASS items 5/6 when the model QUOTES contract text (e.g. reads SKILL.md aloud) without performing the behavior; item 6's `/\/d\/[a-z0-9-]{6,}/` matches incidental paths | LOW | ACCEPTED for M1 (grader mechanism is the deliverable; stub content is expected to fail — RBD-8). **M2 owes**: anchor item 6 to the dev-server origin and grade tool-call events, not prose, before `--require-all` gates anything. |

## Standing relaxations / M2+ obligations

- **Stub plugin bundle** (`test/first-run/stub-plugin/`) is scaffolding-for-testing
  only (RBD-9). M3 replaces the harness `--bundle` target with
  `distribution/claude-plugin` once it exists; the marketplace path is already
  parameterized.
- **Grader checklist content** encodes the coaching contract per the design's M2
  section; M2 iterates the real `shared/skill.md` / `shared/onboard.md` against
  it and owns clean-pass exit criteria (Sam signs off on mechanics + tone).
- **macOS Keychain (finding M6)**: pristine rehearsals are Linux-pod-only by
  design; a Keychain-purge step was deliberately not built.
- **returnTo cap**: measured 364–426 chars worst-case vs the 512 cap (research.md
  R7) — cap kept. If a future client inflates authorize URLs (longer state,
  extra params), re-measure before M3 publish.
- **M1 exit gate (design)**: Sam's HITL sign-off on the demonstrated
  one-command pristine first-run is required before M2 starts.
