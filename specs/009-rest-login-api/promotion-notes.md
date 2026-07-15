# Feature 009 — Promotion Notes

## Post-merge review dispositions (Fable review, 2026-07-15; fixes same-day)

Verdict: APPROVE — 0 HIGH, 0 MEDIUM, 4 LOW. All four fixed:

| Finding | Disposition |
| --- | --- |
| Drift-guard pin (d) treated everything after the OAuth heading as "the OAuth channel", so a bare `claude mcp add` added to a later section would pass vacuously | FIXED — channel bounded at its closing `## ` heading; outside-slice asserted clean |
| `Cache-Control: no-store` only on credential-bearing responses; start responses carry handle+code and non-inline approved embeds the handle in claimCommand | FIXED — no-store stamped on every `/api/login/*` response (router-level); stale pin flipped |
| Malformed JSON to the anonymous front door returned 500 + exception-notifier noise (global error middleware ignored body-parser error types; pre-existing, 009 made it advertised surface) | FIXED — `entity.parse.failed` → 400, `entity.too.large` → 413, no notifier page |
| REST 400 spoke tool vocabulary ("Invalid parameters for tool 'login'") | FIXED — channel-neutral "Invalid agentName:" label in the shared validator |

Review independently re-ran 9 suites (302 tests) and verified: state machine byte-identical, shared budgets single-keyed both ways, one-shot across channels in all permutations, no oracle, no secret logging, nextSteps never contains an expandable secret, discovery amendment additive-only, every agents.md claim true of the code.

## Owed at promotion / needs Sam

- **Deploy** — 009 (and 008's review fixes + migration) are on main, not in prod.
- **G1 ratification**: the "list docs" nextSteps recipe promotes `GET /api/docs` to a documented, drift-guarded public surface (it already accepted sk_sqd_ tokens; now it's advertised).
- **G2 ratification**: `GET /api/login/status` deliberately has no per-IP transport limit (parity with the tool, which only has per-handle slow_down); impose a ceiling on both channels together if wanted.
- **Deferred**: the downloadable `squire` CLI wrapper (squire-sync M5) layers on these endpoints later.
