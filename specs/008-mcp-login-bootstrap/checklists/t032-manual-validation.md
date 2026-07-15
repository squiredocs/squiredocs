# T032 — Manual quickstart validation (feature 008)

Run 2026-07-15 by the implementer against the real server (port 3018, per-agent DB
`collab_test_db_008`).

## Verified through the running server (quickstart §2–§4)

- §2a Anonymous `tools/list` returns exactly `login`, `login_status`. ✅
- §2b Any other anonymous `tools/call` → 401 with the byte-identical
  `Bearer realm="Squire Docs MCP", resource_metadata="…/mcp"` challenge. ✅
- §2c `login({ agentName })` → handle + `XXXX-XXXX` code + `<base>/activate`. ✅
- §2d code entry (`POST /mcp/login/code`) + approve (`POST /mcp/login/decision`)
  under a session token → approved. ✅ (routes; the browser page itself, below)
- §2e poll → approved payload once (has `claimCommand`, no `sk_sqd_`); re-poll → expired. ✅
- §2f `GET /api/mcp/login/claim` → `sk_sqd_` bytes once; second claim → 404. ✅
- §2g reconnect with the claimed token → `tools/list` length 18. ✅
- §3 adversarial checks (rate/caps/slow_down/oracle/hostile name) — covered by
  `login-abuse.test.js`; fabricated-handle claim → uniform 404 confirmed live. ✅
- §4 `agents.md` served with login bootstrap, `/activate`, claim mechanics,
  never-print rule, tool count eighteen. ✅
- `/activate` serves the SPA shell (index.html) in the production build. ✅

## A1 (analyze) — quickstart BASE port

`quickstart.md` uses `BASE=http://localhost:3001`. Confirmed correct: the dev
backend runs on port 3001 (docs/dev.md "Express backend on port 3001"; server
default `PORT || 3001`). No change needed.

## Owed to Sam (cannot be driven headlessly)

- Real-browser walkthrough of `/activate`: the signed-out Google sign-in
  round-trip (`/login?returnTo=/activate`), lowercase+hyphen code entry, the
  skeptical consent card rendering, and the visual result states. The page logic
  and every state transition are covered by `ActivatePage.test.jsx` (10 tests),
  but a human visual pass in a browser is still owed.
