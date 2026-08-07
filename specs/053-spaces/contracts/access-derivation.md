# Contract — Access derivation: the `document_access` view and its thirteen call sites

The single mechanism behind FR-005, FR-025, FR-026, FR-027, FR-028 and SC-002/SC-004. If a reviewer reads one artifact of this feature, it should be this one.

---

## 1. The view (migration M3, `1799820000000_create-document-access-view.js`)

```sql
CREATE VIEW document_access AS
SELECT
  src.doc_id,
  src.user_id,
  -- I2: rank arithmetic, NOT the doc_role enum, whose declaration order
  -- ('owner','editor','viewer') collates owner < editor < viewer — the exact
  -- inverse of the privilege ladder. GREATEST() on doc_role returns the WEAKER
  -- role. See specs/053-spaces/research.md R2.
  (ARRAY['viewer','editor','owner'])[
     GREATEST(COALESCE(MAX(src.direct_rank), 0), COALESCE(MAX(src.space_rank), 0))
  ]::doc_role                                        AS role,
  (ARRAY['viewer','editor','owner'])[MAX(src.direct_rank)]::doc_role AS direct_role,
  (ARRAY['viewer','editor','owner'])[MAX(src.space_rank)]::doc_role  AS space_role
FROM (
  -- direct leg
  SELECT ds.doc_id,
         ds.user_id,
         CASE ds.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END AS direct_rank,
         NULL::int AS space_rank
    FROM document_shares ds
  UNION ALL
  -- space leg (D3 union, D5 uncapped passthrough)
  SELECT d.id,
         sm.user_id,
         NULL::int,
         CASE sm.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END
    FROM documents d
    JOIN space_members sm ON sm.space_id = d.space_id
) src
GROUP BY src.doc_id, src.user_id;
```

### Guarantees

| G | Statement |
|---|---|
| G1 | A `(doc_id, user_id)` row exists **iff** the user has at least viewer access by some route. Absence = no access, identical in meaning to a missing `document_shares` row today. |
| G2 | `role` is the stronger of the two legs (D3), uncapped (D5) — a space `owner` member gets `owner` on every document in the space, including delete, share-management and move-out. |
| G3 | `direct_role` is exactly today's `document_shares.role`, or NULL. Everything that meant "owned" before this feature must read this column, not `role` (RBD-053-7/-14). |
| G4 | `space_role` is the membership role via `documents.space_id`, or NULL. |
| G5 | Personal documents (`space_id IS NULL`) produce no space-leg rows, so `role = direct_role` and every query returns byte-identical results to today (SC-007). |
| G6 | Quals on `doc_id`/`user_id` push down through the aggregate into both branches (research R3). The view exposes no other non-aggregated column, deliberately — **do not add `space_id` to it**. |

### Required indexes (created in M1)

- `document_shares` already has `document_shares_doc_user_unique (doc_id, user_id)` plus single-column indexes on each (`migrations/004:70-77`).
- `space_members`: `UNIQUE (space_id, user_id)` (serves `d.space_id` + `sm.user_id` lookups) and an index on `(user_id)` (serves the search shape, where `user_id` is the only bound value).
- `documents (space_id)`.

### Verification (task T010, mandatory before the search work lands)

`EXPLAIN` both shapes against a seeded database and confirm index scans, no sequential scan of `document_shares`:

```sql
EXPLAIN SELECT role FROM document_access WHERE doc_id = $1 AND user_id = $2;
EXPLAIN SELECT * FROM document_search_index si
   JOIN document_access ds ON ds.doc_id = si.doc_id AND ds.user_id = $1;
```

If pushdown does not materialize, fall back to research R1 alternative (a) — a JS-emitted `JOIN LATERAL` fragment — and record the reversal in `clarifications-needed.md`. Do not ship an unverified plan on the hottest permission query in the app.

---

## 2. Call-site map — every place the predicate lives

| # | File:line (today) | Change |
|---|---|---|
| 1 | `server/documents.js:39` `getRole` | `SELECT role FROM document_access WHERE doc_id = $1 AND user_id = $2`. Signature, return type (`'owner'|'editor'|'viewer'|null`) and every caller unchanged. |
| 2 | `server/documents.js:253` list join | `JOIN document_access ds ON d.id = ds.doc_id AND ds.user_id = $1` |
| 3 | `server/documents.js:227-233` `roleCondition` | `ds.role` → `ds.direct_role`; `shared_with_me` becomes `(ds.direct_role IS NULL OR ds.direct_role <> 'owner')` — a space-only document has **no** direct role and must appear under "shared with me", not vanish |
| 4 | `server/search.js:262` `kw_doc` | relation name only |
| 5 | `server/search.js:269` `kw_chunk` | relation name only |
| 6 | `server/search.js:290` `top_chunks` | relation name only |
| 7 | `server/search.js:323` outer `ds2` | relation name only; `ds2.role` (`:314`) becomes effective for free |
| 8 | `server/search.js:87-91` `buildRoleCondition` | `${alias}.role` → `${alias}.direct_role`, same `IS NULL` treatment as #3 |
| 9 | `server/mcp/tools/share-document.js:70` | deleted — the tool moves to `share-service.js` (see `contracts/share-attribution.md`) |
| 10 | `server/mcp/tools/set-document-title.js:58-74` | `const role = await documents.getRole(docGuid, userId); if (!role) throw new Error('Document not found or you do not have access'); if (documents.ROLES[role] < documents.ROLES.editor) throw new Error('You do not have edit permission for this document');` — **error strings preserved verbatim** |
| 11 | `server/mcp/tools/set-document-version-name.js:186-202` | `if (!await documents.hasAccess(docGuid, userId)) throw new Error('Document not found or you do not have access');` (viewer+, per the Sam-ratified 2026-07-19 note kept in place) |
| 12 | `server/mcp/tools/list-document-versions.js:111-122` | same as #11 |
| 13 | `server/mcp/agent-presence.js:166-183` `_verifyDocumentAccess` | role from `documents.getRole`; keep the `users` row lookup (`name/email/picture`) as its own query. The `options.requiredRole` gate at `:751-756` and its `ROLES` import are unchanged. |

Two `document_shares` references in the outer search query are **not** access predicates and stay as they are: `share_count` (`server/search.js:319`) and the `owner_share`/`owner_user` join (`:324-325`). Same for `server/documents.js:250, 254-255`. See RBD-053-15.

`server/documents.js:312` (`searchUsers`'s `excludeDocId` NOT EXISTS) also stays on `document_shares`: the share autocomplete excludes people who already hold a **direct** share, and space members are not directly shared. RBD-053-15.

---

## 3. What `getAccessibleDocuments` gains (FR-026, FR-040)

Signature: `getAccessibleDocuments(userId, { search, filter, sortBy, sortOrder, limit, offset, updatedSince, space })`.

`space` accepts:
- `undefined`/`'all'` → no clause. **Result identical to today** (back-compat default, spec Assumptions).
- `'personal'` → `AND d.space_id IS NULL`.
- a uuid → `AND d.space_id = $n`. Bound as a parameter; a non-member asking for someone else's space id simply gets zero rows (the access join already excludes them) — no distinguishable refusal (I11).

New projected columns: `d.space_id`, `s.name AS space_name` via `LEFT JOIN spaces s ON s.id = d.space_id`. `ds.role` remains the row's role and is now effective.

`GET /api/docs` (`server/index.js:628`) passes `req.query.space` through with the same validation, and the response rows gain `spaceId`/`spaceName`.

---

## 4. Realtime — no new mechanism (FR-015, FR-031)

Nothing in `server/index.js`'s WebSocket path changes except by consequence:
- upgrade gate `server/index.js:1847` → `permissions.can.view` → `checkPermission` → `documents.getRole` → the view. Space members can now connect.
- 60-second recheck `server/index.js:2062-2097` calls `documents.getRole` directly; a removed member's socket closes with `4403 'Access revoked'` and a demoted member's `currentCanEdit` flips false within a minute — the identical machinery direct-share revocation already uses.
- The fail-closed error branch (`:2088-2089`) and `ws-edit-gate` behavior are untouched.

Presence, awareness dedup, undo/redo, diff and version history are not modified in any way (FR-031).
