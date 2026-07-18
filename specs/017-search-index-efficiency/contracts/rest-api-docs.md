# Contract — `GET /api/docs` content-search branch (`updatedAfter`)

**Entry point**: `server/index.js`, `/api/docs` handler (content branch: `search` present
AND `searchMode=content`). Auth: session JWT (`requireAuth`). Rate limit: existing per-user
`search` limiter — unchanged, still enforced on every content search (FR-021).

## Request (delta only — all existing params unchanged)

| Param | Type | Rules |
|-------|------|-------|
| `updatedAfter` | ISO-8601 timestamp string (e.g. `2026-07-01T00:00:00Z`) | Optional. Valid ONLY when `search` is non-empty AND `searchMode=content`. Admits documents with `documents.updated_at` **strictly after** the instant (exclusive; equal timestamp is excluded). Applied inside each engine's candidate CTE before ranking/fusion, in all three `mode`s and both hybrid legs. Composes with `filter`, `sortBy`/`sortOrder`, `limit`/`offset`, `distanceThreshold`. |

## Validation (performed before the rate limiter; CN-3, FR-014, FR-018)

| Condition | Response |
|-----------|----------|
| `updatedAfter` present, but no content search (`search` missing/empty, or `searchMode` ≠ `content`) | `400 {"error": "updatedAfter requires a content search: pass search=<query> with searchMode=content"}` |
| `updatedAfter` unparseable as a timestamp | `400 {"error": "updatedAfter must be a valid ISO-8601 timestamp"}` |
| `updatedAfter` in the future | Valid — `200` with `docs: []`, `pagination.total: 0` |

(Exact error strings are normative for tests; both come from the shared validator
`parseUpdatedAfter` in `server/search.js`.)

## Response

**Unchanged shape** (FR-008/FR-019/FR-022):
`{ docs: [{ docGuid, title, updatedAt, role, ownerName, ownerEmail, snippet, score,
shareCount }], pagination: { total, limit, offset, hasMore } }`.

- `pagination.total` counts only documents passing the recency filter (FR-016).
- Every returned doc satisfies `updatedAt > updatedAfter` and is accessible to the caller
  (result ⊆ accessible ⊆ same-search-unfiltered; FR-020, SC-004).
- Requests without `updatedAfter` are byte-identical to pre-feature behavior (FR-022).
