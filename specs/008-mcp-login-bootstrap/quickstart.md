# Quickstart — 008-mcp-login-bootstrap

Validation guide: prove the login bootstrap end-to-end. Contracts in
[contracts/](./contracts/), entities in [data-model.md](./data-model.md).

## Prerequisites

- Dev environment per `docs/dev.md` (commands run in the Minikube `app-dev` pod).
- Migration applied: `npm run migrate up` (creates `mcp_pending_authorizations`).
- Dev server running (restart it — mutagen can leave a stale server).
- A browser with (or without — signup is part of US3) a Squire Google account.

## 1. Automated suites (authoritative)

```bash
# Backend — serial only (shared DB)
npx jest --runInBand \
  server/mcp/__tests__/auth/anonymous-surface.test.js \
  server/mcp/__tests__/auth/pending-authorizations.test.js \
  server/mcp/__tests__/auth/login-flow.test.js \
  server/mcp/__tests__/auth/login-abuse.test.js \
  server/mcp/__tests__/tools/login.test.js \
  server/mcp/__tests__/tools/login-status.test.js \
  server/__tests__/mcp-login-claim.test.js \
  server/__tests__/agents-md-claims.test.js

# Regression: OAuth surface byte-identical (SC-003)
npx jest --runInBand server/mcp/__tests__/auth/

# Full backend gate before merge
npx jest --runInBand
```
Expected: all green; the OAuth suites pass with zero modifications.

## 2. Manual happy path (US1 + US2 + US3)

Simulate the agent with curl (any MCP client works too):

```bash
BASE=http://localhost:3001   # dev server

# a) Anonymous handshake lists exactly two tools
curl -s -X POST $BASE/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
# expect: "login", "login_status" — nothing else

# b) Any other anonymous tool 401s with the untouched challenge
curl -si -X POST $BASE/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_documents"}}' \
  | grep -i 'HTTP/\|WWW-Authenticate'
# expect: 401 + Bearer realm="Squire Docs MCP" … resource_metadata="…"

# c) login
curl -s -X POST $BASE/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"login","arguments":{"agentName":"Quickstart Agent"}}}' \
  | jq -r '.result.content[0].text'
# note handle + userCode + verificationUri; save: H=<handle>

# d) Browser: open $BASE/activate (signed out → Google sign-in round-trips back).
#    Enter the code lowercase with the hyphen — accepted. Verify the consent page
#    says "An agent calling itself “Quickstart Agent”…", shows exactly
#    documents:read + documents:write, and offers Approve/Deny. Approve.

# e) Poll → approved payload (once): claim command, NO credential
curl -s -X POST $BASE/mcp -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"login_status\",\"arguments\":{\"handle\":\"$H\"}}}" \
  | jq -r '.result.content[0].text'
# poll again: status is "expired" (payload was one-shot) — handle still claims below

# f) Claim over REST (one-shot)
umask 077 && curl -fsS -H "Authorization: Bearer $H" \
  "$BASE/api/mcp/login/claim" -o /tmp/squire-cred && chmod 600 /tmp/squire-cred
curl -si -H "Authorization: Bearer $H" "$BASE/api/mcp/login/claim" | head -1
# expect: second claim → 404

# g) Reconnect with the credential: full 18-tool set, standard attribution
TOK=$(cat /tmp/squire-cred)
curl -s -X POST $BASE/mcp -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/list"}' | jq '.result.tools | length'
# expect: 18; then a list_documents call succeeds
```

Verify in Settings: AI Agent Access shows "Quickstart Agent"; API Tokens shows
"Quickstart Agent (via MCP login)". Revoke the delegation → the token stops
authenticating on next use (FR-023).

## 3. Adversarial spot-checks (US4)

- Call `login` 11 times in a minute from one IP → 11th returns `rate_limited`.
- Create 5 pending authorizations, call `login` again → `rate_limited`, nothing created.
- Poll `login_status` twice within 5 s → second is `slow_down` and the required
  interval grows by 5 s; handle still works.
- Submit 6 wrong codes in a minute at `/activate` → 429; wrong vs expired vs used code
  → identical message.
- Poll/claim a fabricated handle → indistinguishable from expired.
- Approve, wait > 5 min without claiming → poll says expired, claim 404s, and the
  delegation is gone from Settings (check after triggering any login call — lazy sweep).
- `login({ agentName: "<img src=x onerror=alert(1)>" })` → consent page shows the
  literal text, inert.

## 4. Documentation checks (US5)

```bash
curl -s $BASE/agents.md | grep -iE 'login_status|/activate|eighteen|never print'
```
Expect: login bootstrap present as the recommended in-session path, claim mechanics,
credential-handling rule, tool count eighteen; PKCE walkthrough still present.
`server/__tests__/agents-md-claims.test.js` pins all of this.

## Success criteria mapping

| SC | Check |
|---|---|
| SC-001 | Step 2 (four user actions: open, sign in, enter code, approve; < 2 min) |
| SC-002 | Steps 2e/2f — transcript holds only URL + code + handle; credential lands on disk |
| SC-003 | Step 1 OAuth regression + quickstart 2b |
| SC-004 | Abuse suite (rate/cap math asserted in login-abuse.test.js) |
| SC-005 | One-shot tests: double-claim, double-code, terminal states |
| SC-006 | Settings revoke check above |
| SC-007 | slow_down test + compliant poll loop ≤ 12 req/min |
