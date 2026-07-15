# Data Model: 009-rest-login-api

**No database entities are added or changed.** No migration (spec Out of Scope; Constitution:
node-pg-migrate only, nothing to migrate). The pairing/pending-authorization table
(`mcp_pending_authorizations`), delegations, and API tokens are 008's, untouched. This file records
the **payload shapes** the feature adds/changes — the product contract surfaces.

## Existing entities (unchanged, from 008)

- **Pairing (pending authorization)** — the one state machine (pending → approved → claimed / denied
  / expired), now reachable through two doors (MCP tool, REST). No new states, fields, or transitions.
- **Handle** — high-entropy (`sqlh_` + 256 bits), one-shot session binding, stored hashed; now also
  the Bearer credential for `GET /api/login/status`. Carrier rule: `Authorization: Bearer` only, every
  route.
- **Channel** — the door an interaction used (MCP tool / REST canonical / REST alias / inline),
  recorded where 008 already records `claim_channel`. Security-relevant state (one-shot, poll interval,
  budgets) is per-pairing / per-IP, NEVER per-channel.

## New / changed payload elements

### `nextSteps` block (new)
Attached to the approved and inline delivery payloads by `login-service`. Shape and requirements:
[contracts/next-steps-block.md](./contracts/next-steps-block.md). Contains no secrets; identical
across the tool and REST consumers.

### `restApi` discovery block (new)
Additive element of the `GET /mcp` manifest: `{ loginStart, documentation }` (absolute URLs).
Shape: [contracts/discovery-and-instructions.md](./contracts/discovery-and-instructions.md).

### `POST /api/login/start` response (new surface, existing data)
Superset of `{ userCode, verificationUri, handle, pollIntervalSeconds }` mirroring the tool's
`pending_authorization` payload (RD-1). No new persisted fields — derived from the existing pairing
row and `buildBaseUrl`.

### `GET /api/login/status` response (new surface, existing data)
The `login_status` decision table as plain JSON (RD-2), all outcomes at HTTP 200. Approved/inline
payloads gain `nextSteps`. No new persisted fields.

## Operational constants (unchanged, contracts-by-value)
`login-constants.js`: `LOGIN_CALLS_PER_MINUTE_PER_IP=10`, `CLAIM_ATTEMPTS_PER_MINUTE_PER_IP=10`,
`MAX_PENDING_PER_IP=5`, `MAX_PENDING_GLOBAL=500`, `AUTHORIZATION_TTL_SECONDS=600`,
`CLAIM_WINDOW_SECONDS=300`, `MIN_POLL_INTERVAL_SECONDS=5`, `CREDENTIAL_TTL_DAYS=30`. Tunable without a
spec edit. If the shared login rate-limit key is promoted to a named constant, it lives here too.
