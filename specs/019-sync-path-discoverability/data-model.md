# Data Model — 019-sync-path-discoverability

**No database schema changes.** No migrations (spec Out of Scope). All entities
are in-memory values, Redis records of an existing shape, or contract-level
concepts.

## Entities

### Import recipe (new, in-memory — the value `import_markdown_file` returns)

| Field | Type | Notes |
|---|---|---|
| `command` | string | ONE compound shell command: claim → curl import → receipt write-back (research R2). Contains the one-shot claim secret (existing accepted residue) and a single `FILE=` placeholder line. Never contains document content or an `sk_sqd_` token. |
| `intent` | `"create" \| "update" \| "sync"` | Resolved intent (RBD-1 defaulting applied). |
| `docGuid` | string? | Echoed only for `update`/`sync`. |
| `claimExpiresInSeconds` | number | `pendingMints.CLAIM_TTL_SECONDS` (300). |
| `message` | string | States the FILE line is the only edit; one-shot/5-minute semantics; re-call for a fresh recipe. |
| `guidance` | string | Shell-less path (RBD-5): `create_access_token({ inline: true })` + `rest_api` for HTTP-capable agents; in-context `create_document`/`modify` (+`allowRetyped` above threshold) for small content. |

**Validation rules** (tool boundary): input at most `{ docGuid?, intent? }`;
`update`/`sync` require `docGuid`; `create` forbids it; omitted intent → `sync`
if `docGuid` present else `create`; registry scope gate `documents:write`.
**No state**: the tool never probes the target document (FR-008).

### Pending mint (existing — `server/mcp/auth/pending-mints.js`)

Redis record keyed by SHA-256 of the `one_time_use_` claim secret; value
`{ userId, name, scopes, ttlSeconds, mintedByDelegationId, mintedByApiTokenId }`;
`EX 300 NX`; atomic one-shot redemption. **019 adds a second creator call site
(via the extracted `prepareClaimDelivery()` helper) and changes nothing about the
record, TTL, hashing, redemption, or claim endpoint.** Recipe mints use scopes
`["documents:read", "documents:write"]` and the default 1 h token TTL (RBD-6).

### Teaching thresholds (new, in-memory config)

| Name | Env var | Default | Semantics |
|---|---|---|---|
| nudge | `CREATE_DOCUMENT_NUDGE_BYTES` | 2,048 | ≥ ⇒ success result appends byte-channel pointer |
| refusal | `CREATE_DOCUMENT_REFUSAL_BYTES` | 10,240 | ≥ ⇒ refuse unless `allowRetyped: true` |

Metric: UTF-8 byte length of the `markdown` argument. Invalid pair (non-numeric,
non-integer, ≤ 0, refusal ≤ nudge) ⇒ both fall back to defaults (RBD-3). Read at
call time. State transitions of a create_document call:

```
bytes < nudge                        → unchanged behavior (FR-021)
nudge ≤ bytes < refusal              → create + nudge appended (FR-018)
refusal ≤ bytes, no allowRetyped     → refuse, create NOTHING (FR-019)
refusal ≤ bytes, allowRetyped: true  → create + nudge (FR-020)
```

### Hidden deprecation alias (new, registry-level — DR-1)

`read_document_version` moves from the advertised `tools` map to a
`HIDDEN_TOOL_ALIASES` map in `server/mcp/tools/index.js`: absent from
`getToolList()`, still resolved by `getTool()`/`executeTool()`, scope entry
retained. Advertised tool count after 019: **sixteen**.

### Byte budgets (contract-level constants)

Tool descriptions ≤ 2,048 UTF-8 bytes (every advertised tool, one shared test);
server instructions ≤ 1,536 UTF-8 bytes (RBD-7). Measured against implement-time
`main` by requiring the live modules (research R4).
