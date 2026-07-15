# Contract: discovery manifest `restApi` block + anonymous instructions

Modules: `server/mcp/index.js` (`GET /mcp` handler, `ANON_SERVER_INSTRUCTIONS`). Amended pin:
`server/mcp/__tests__/auth/anonymous-surface.test.js`.

## `GET /mcp` restApi block (FR-014, RD-7)

Add an additive block to the discovery manifest, built from `buildBaseUrl(req)`:
```json
{
  "name": "collab-editor-mcp",
  "version": "1.0.0",
  "protocolVersion": "2024-11-05",
  "capabilities": { "tools": {} },
  "authentication": { "...unchanged...": "..." },
  "restApi": {
    "loginStart": "<baseUrl>/api/login/start",
    "documentation": "<baseUrl>/agents.md#<choose-your-channel anchor>"
  }
}
```
- All pre-existing fields (`name`, `version`, `protocolVersion`, `capabilities`, every
  `authentication.*` field) MUST remain **byte-identical** to before.
- `restApi` is the first place the manifest names a non-MCP surface. Field names pinned by the
  contract test; the `documentation` anchor MUST match the restructured agents.md heading slug.
- Additive JSON: strict consumers rejecting unknown fields is an accepted, deliberate,
  non-breaking amendment (spec edge case) — flagged in the amended pin, not silent.

## Amended discovery pin (FR-015 — deliberate, not discovered-in-a-failing-test)

`anonymous-surface.test.js` currently asserts "GET /mcp discovery response is unchanged" (pins
`name`, `protocolVersion`, `authentication.type`, `authentication.authorizationUrl`). Rewrite it to:
- assert the new `restApi.loginStart` and `restApi.documentation` (absolute, `<baseUrl>`-derived), AND
- continue to pin every pre-existing field (the pin evolves, it is not deleted).
Traceable to this spec (FR-014/FR-015). This is the ONE deliberate contract change to the 008
"unchanged" pin.

## Anonymous server instructions (FR-016)

`ANON_SERVER_INSTRUCTIONS` gains a mention that the login flow is also available as plain REST
(naming the start endpoint or where to find it), while:
- keeping the existing critical content LEADING: unauthenticated state, the two tools (`login`,
  `login_status`), both escape hatches (login onboarding + native OAuth), the credential rule
  (never print/echo/paste; handle is acceptable residue);
- staying within the **2 KB** client truncation budget (there is a tool-inventory / instruction-budget
  guard test — keep it green; the current string is ~700 chars so there is ample headroom).

`SERVER_INSTRUCTIONS` (authenticated variant) is unchanged.

## Invariants (tested)

- `GET /mcp` carries `restApi.{loginStart,documentation}` as absolute URLs; all pre-existing fields
  byte-identical (amended `anonymous-surface.test.js`).
- `ANON_SERVER_INSTRUCTIONS` contains a REST-login mention and is `< 2048` bytes; the anonymous
  initialize still returns exactly `ANON_SERVER_INSTRUCTIONS`.
- The `documentation` anchor resolves to a real heading in `client/public/agents.md`.
