# Contract: `oauth-chain-driver.mjs --signin-link`

File: `test/first-run/oauth-chain-driver.mjs` (hand-run script; not part of
`test:first-run`).

## Flags

| Flag | Meaning |
| --- | --- |
| `--server URL` | unchanged |
| `--redirect-uri URL` | unchanged |
| `--first-run` | unchanged (dev faucet browser mode); exclusive with `--signin-link` |
| `--signin-link URL` | NEW. Replaces the faucet leg with sign-in-link redemption and production consent approval. |
| `--expect-name NAME`, `--expect-email EMAIL` | NEW, with `--signin-link`: assert the redeemed user's name and email. |
| `--script-check` | NEW, with `--signin-link`: after `list_documents`, call `modify` on the welcome document with a one-line script that appends a paragraph; assert no `is_error`. |

`--signin-link` together with `--first-run`: usage error, exit 2.

## `--signin-link` leg (replaces steps 6 and 7)

1. Parse `URL`: the origin must equal `--server`'s origin; the fragment is
   the token.
2. `POST /auth/signin-link`, `Accept: application/json`, body `{ token }`.
   Expect 200 and `{ ok: true, user }`; check `--expect-*`; keep
   `user.welcomeDocId`.
3. Collect `accessToken` and `refreshToken` from `Set-Cookie`.
4. `POST /auth/refresh` with `Cookie: refreshToken=...`; expect 200 and
   `{ accessToken }` (the session Bearer token).
5. `GET /auth/providers`; expect `hasOwner: true`.
6. `GET <authorization_endpoint>?...` (manual redirect) expects a redirect to
   the consent page (unchanged sanity step).
7. `POST /mcp/auth/approve` with `Authorization: Bearer <session>`,
   `Accept: application/json`, body `{ agent_client_id, scopes:
   ['documents:read','documents:write'], redirect_uri, state, code_challenge,
   code_challenge_method: 'S256', approved: true }`. Expect 200 and
   `{ redirectUrl }` whose `state` matches; take `code`.

Steps 8 and 9 (token exchange, `initialize`, `list_documents`) are unchanged;
`--script-check` adds the `modify` call.

Never calls `/auth/dev-login` or `/auth/dev-consent-approve` in this mode (a
source test asserts the `--signin-link` branch contains neither path).

Exit 0 on success; 1 with one message on the first failure; 2 on usage.
