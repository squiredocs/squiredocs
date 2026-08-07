# Phase 1 Data Model — 053-spaces

Source of truth: `design/spaces.md` § Data Model. This file restates it in the shapes the migrations must produce, adds the invariants that make the permission model true, and records the state transitions the service layer must enforce.

Migration files: `M1 1799800000000_create-spaces.js`, `M2 1799810000000_add-granted-by-to-document-shares.js`, `M3 1799820000000_create-document-access-view.js`.

---

## 1. New tables (M1)

### `spaces`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK, default `uuid_generate_v4()` | matches `document_shares.id` convention (`migrations/004:45-49`) |
| `name` | varchar(100) | NOT NULL | app also enforces trimmed-non-empty (FR-004 / RBD-053-1). **No uniqueness constraint** — duplicates are allowed by decision |
| `created_by` | uuid | NULL, `REFERENCES users(id) ON DELETE SET NULL` | audit only; the *owner* is a `space_members` row, not this column |
| `created_at` | timestamptz | NOT NULL default `now()` | |
| `updated_at` | timestamptz | NOT NULL default `now()` | plus the existing `update_updated_at_column()` trigger, same as `documents` (`migrations/004:36-42`) |

### `space_members`

| Column | Type | Constraints |
|---|---|---|
| `space_id` | uuid | NOT NULL, `REFERENCES spaces(id) ON DELETE CASCADE` |
| `user_id` | uuid | NOT NULL, `REFERENCES users(id) ON DELETE CASCADE` |
| `role` | `doc_role` | NOT NULL — reuses the existing enum (D2) |
| `granted_by` | uuid | NOT NULL, `REFERENCES users(id)` **ON DELETE NO ACTION** (D8 / FR-036) |
| `created_at` | timestamptz | NOT NULL default `now()` |

`UNIQUE (space_id, user_id)`; index on `(user_id)`.

### `space_invites`

| Column | Type | Constraints |
|---|---|---|
| `space_id` | uuid | NOT NULL, `REFERENCES spaces(id) ON DELETE CASCADE` |
| `email` | text | NOT NULL — stored as entered, matched case-insensitively |
| `role` | `doc_role` | NOT NULL |
| `invited_by_user_id` | uuid | NULL, `REFERENCES users(id) ON DELETE SET NULL` — **nullable by decision** (FR-036), mirroring `document_share_invites` |
| `created_at` | timestamptz | NOT NULL default `now()` |

`CREATE UNIQUE INDEX ... ON space_invites (space_id, lower(email))` and `CREATE INDEX ... ON space_invites (lower(email))` — byte-for-byte the `document_share_invites` index pair (`migrations/1787000000000:45-51`); the second one is what login-time conversion scans.

## 2. Altered tables

| Table | Change | Migration | Semantics |
|---|---|---|---|
| `documents` | `+ space_id uuid NULL REFERENCES spaces(id) ON DELETE SET NULL`, index on `space_id` | M1 | NULL = personal, the state of every existing row (D1). The `SET NULL` **is** the space-deletion rule: documents revert to personal, never deleted (FR-024). |
| `document_shares` | `+ granted_by uuid NOT NULL REFERENCES users(id)` (NO ACTION), added nullable → backfilled → `SET NOT NULL` in one transaction | M2 | D8. See §5. |

Nothing else changes. `documents.creator_id` keeps its nullable `ON DELETE SET NULL` shape (`migrations/007:11-15`) — which is why the backfill chain needs a third fallback.

## 3. The `document_access` view (M3)

The single derivation of effective role. Full SQL and call-site mapping live in `contracts/access-derivation.md`; the model-level contract is:

| Column | Meaning | Consumers |
|---|---|---|
| `doc_id`, `user_id` | grouping keys; the ONLY non-aggregated outputs (keeps qual pushdown — research R3) | all |
| `role` | **effective** = stronger of direct and space (D3/D5) | `getRole`, all authorization, `ds2.role` projected by search |
| `direct_role` | the `document_shares` role, NULL if none | `owned`/`shared_with_me` filters (RBD-053-7/-14), ownership counts, the move rule's ownership half |
| `space_role` | the `space_members` role via `documents.space_id`, NULL if none | the share dialog's read-only audience line (FR-043), refusal explanations |

A `(doc_id, user_id)` pair appears iff at least one leg grants something; absence means no access, exactly as a missing `document_shares` row means today.

## 4. Invariants

| # | Invariant | Enforced by |
|---|---|---|
| I1 | A document has exactly one home: `space_id IS NULL` (personal) or one existing space | single nullable column + FK (D1) |
| I2 | Effective role = `max(direct_rank, space_rank)` under `{owner:3, editor:2, viewer:1}` — **never** the enum's own ordering, which is inverted | the view's rank mapping (research R2); asserted by test |
| I3 | Every space always has ≥1 owner | `assertNotLastOwner` on leave / remove / demote (FR-010, research R11) |
| I4 | At most one membership per (space, user) | `UNIQUE (space_id, user_id)` |
| I5 | At most one pending invite per (space, lower(email)) | unique expression index (FR-020) |
| I6 | A pending invite never lowers a role — neither an existing membership at conversion nor an earlier pending invite at re-invite | `ON CONFLICT DO NOTHING` at conversion; rank-comparing upsert at re-invite (RBD-053-9, research R12) |
| I7 | Every `document_shares` row and every `space_members` row carries a grantor | `NOT NULL` after M2; `setRole`'s required 4th argument (research R5) |
| I8 | A grant's grantor is never orphaned or cascade-deleted | `ON DELETE NO ACTION` + the reassignment step in `deleteUserByEmail` (RBD-053-11) |
| I9 | Moves never write `document_shares` | `moveDocument` touches only `documents.space_id` (FR-014) |
| I10 | "Owned" means a direct owner share, everywhere (list filter, search filter, admin counts, onboarding engagement) | `direct_role` in filters; the three counting queries stay on `document_shares` (FR-030, RBD-053-7/-14) |
| I11 | A non-member cannot distinguish "space exists" from "space does not exist" | uniform 404 from every `/api/spaces/:id*` route (RBD-053-10, FR-039) |

## 5. `granted_by` backfill (M2, one statement)

```sql
UPDATE document_shares ds
SET granted_by = COALESCE(
      (SELECT o.user_id FROM document_shares o
        WHERE o.doc_id = ds.doc_id AND o.role = 'owner' LIMIT 1),   -- 1. the document's current owner
      (SELECT d.creator_id FROM documents d WHERE d.id = ds.doc_id), -- 2. its creator (nullable)
      ds.user_id)                                                    -- 3. the share's own holder (NOT NULL)
WHERE ds.granted_by IS NULL;
```

Cannot yield NULL (term 3 is the row's own NOT NULL column), so the subsequent `SET NOT NULL` cannot fail. Backfilled values are the *most likely* grantor, not a verified one (FR-033); only post-migration rows are exact.

Post-migration write paths and their grantor (FR-034):

| Path | Anchor | Grantor |
|---|---|---|
| REST share endpoint | `server/index.js:1006` → `share-service.js` | acting user |
| MCP `share_document` | `server/mcp/tools/share-document.js` → `share-service.js` | acting user (the token's owner) |
| Role change | `server/index.js:1067` → `setRole` | acting user (a role change is a new grant) |
| Invite conversion | `server/auth/users.js:122` | `invited_by_user_id`, falling back to the doc owner, then the invitee (RBD-053-13) |
| Document creation (owner row) | `server/documents.js:137` | the creator |
| Onboarding welcome doc | `server/onboarding.js:50` → `document-service.js:551` → `createDocument` | the new user |
| Space membership | `server/spaces.js` | inviter; at creation, the creator grants themselves owner |

## 6. State transitions

**Document home** — `personal ⇄ space A ⇄ space B`
- *in* (`NULL → S`, `A → S`): actor holds a **direct** owner share AND is `editor|owner` member of `S` (FR-011). Passthrough owner does not qualify.
- *out* (`S → NULL`): actor holds a direct owner share **or** is an `owner` member of `S` (FR-012). The second is the curation path and may target only `NULL` (RBD-053-3).
- *across* (`A → B`): both rules, composed (FR-013).
- same-target: no-op success. Deleted target: clean failure. Never touches shares (I9).

**Membership** — `none → invited (pending) → member(role) → none`
- `none → pending`: unknown email, any member, role ≤ inviter's (FR-008/FR-009).
- `pending → pending'`: re-invite raises only (I6).
- `pending → member`: first login, transactional, `DO NOTHING` on conflict (FR-018).
- `none → member`: known email, immediate.
- `member → member'`: owner-only role change; downward blocked for the last owner (I3).
- `member → none`: leave (self) or remove (owner); blocked for the last owner. Direct shares survive (FR-022).
- `pending → none`: owner revokes (FR-023 / RBD-053-4).

**Space** — `created → renamed* → deleted`
- create: any user; creator inserted as `owner` with `granted_by = self`.
- rename/delete: owner only. Delete cascades members + invites, and `documents.space_id` reverts to NULL via `SET NULL`; content, history, and direct shares untouched (FR-024).

## 7. Key entities → storage

| Spec entity | Storage |
|---|---|
| Space | `spaces` row |
| Space membership | `space_members` row |
| Space invite | `space_invites` row |
| Document home | `documents.space_id` |
| Effective role | **derived**, `document_access.role` — never stored |
| Share grant attribution | `document_shares.granted_by`, `space_members.granted_by` |
