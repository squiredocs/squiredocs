# Feature 008 — Promotion Notes

## Post-merge review dispositions (Fable review, 2026-07-15; fixes same-day)

| Finding | Severity | Disposition |
| --- | --- | --- |
| `trust proxy: true` makes every per-IP limit spoofable via X-Forwarded-For (onboarding DoS by filling the global pending cap with rotating forged IPs) | MEDIUM | FIXED — `trust proxy` now defaults to `1` (exactly the Traefik ingress hop), overridable via `TRUST_PROXY` (hop count or subnet list). **Needs Sam's ratification: confirm prod topology is exactly one proxy hop; if a CDN/LB ever fronts Traefik, set `TRUST_PROXY=2` (or the subnet form) in `k8s/auth.production.env` or limits will key on the LB address.** |
| Anonymous malformed JSON-RPC (bad version) returned a 200 JSON-RPC error instead of the byte-identical missing-credential 401 (SC-003 conformance) | LOW | FIXED — anonymous requests get `sendMissingChallenge` on the version-check path too; regression pinned in anonymous-surface.test.js. |
| `?handle=` claim fallback put a bearer credential in a URL (upstream proxy access logs) | LOW | FIXED — claim is Bearer-header-only; contract amended (claim-endpoint.md); test flipped to pin the rejection + approval survival. |

Review also explicitly verified: frozen OAuth conformance suites untouched; no handle/code ever logged (including notifyException paths); one-shot transitions atomic; auto-revoke targets exactly its own delegation; consent page renders agent name inert, no code-in-URL autofill.

## Owed at promotion / needs Sam

- **Manual browser pass of /activate** (t032-manual-validation.md): signed-out Google round-trip, lowercase/hyphen code entry normalization, consent card rendering, deny/expired/approved result states. Logic is unit-covered; the visual pass cannot be driven headlessly.
- **G1 ratification (D1)**: a credential-less MCP client now completes an anonymous handshake exposing the two login tools, where pre-008 the 401 triggered client-side OAuth. Every other request is byte-identical (pinned by tests). Sam should confirm this observable onboarding change is acceptable — it is the feature's core mechanism.
- **D11 veto hook**: `login_status({ inline: true })` in-band credential delivery for shell-less agents ships enabled; strike it if the do-not-echo warning is judged insufficient.
- **TRUST_PROXY ratification** (see table above).
- Deploy: not deployed; lands with the next prod deploy (Sam triggers).

## Live-test findings (2026-07-15, Sam's onboarding attempt)

- **Prod is running 008 code WITHOUT the migration**: anonymous `login` on squiredocs.com errors with `relation "mcp_pending_authorizations" does not exist`. The dev-cluster migration ran in the merge queue; prod's did not. **Action (Sam): run the prod deploy script (it waits for migrations) or apply migrations in prod, then redeploy to pick up commits a6cbb8f + 7850781.**
- **Anonymous error leak** (found via the same probe): unexpected tool exceptions returned raw internal messages (the DB relation error) to unauthenticated callers. FIXED in 7850781 — anonymous tool exceptions collapse to a generic message; pinned in tests.
- **Docs gap that actually caused the failed test**: the tester's agent had a shell but no attached MCP server, and agents.md's login section presumed an attached client — so the agent concluded `claude mcp add` was a hard prerequisite and stopped. FIXED in 7850781: new "No MCP connection? Bootstrap with curl" section (JSON-RPC via curl → claim to disk → credentialed `claude mcp add --header` or REST-only collaboration), drift-guard pins (s)/(t).
