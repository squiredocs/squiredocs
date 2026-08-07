# Feature Specification: Spaces (Shared Team Workspaces)

**Feature Branch**: `053-spaces`

**Created**: 2026-08-07

**Status**: Draft

**Input**: User description: "Spaces (shared team workspaces) per design/spaces.md — feature 053-spaces, pre-assigned"

**Design ground truth**: `design/spaces.md` — "Squire Spaces (Shared Team Workspaces)", RATIFIED 2026-08-07 (Sam). All eight decisions D1–D8 are taken and recorded in the doc's Decisions ledger (D7 ratified as a starting point, open to revision once spaces are in use). Per Constitution Principle VI this spec encodes the design; it does not relitigate it. Open points where the design is silent are recorded as RATIFIED-BY-DEFAULT in `clarifications-needed.md`.

## The Problem

Today the only way a team shares a set of documents is to share each document with each person individually: N documents × M teammates = N×M share grants, repeated for every new document and every new hire. A space is a named container for documents with a member list — the team joins once, and membership gives each member a baseline role on every document in the space, current and future. Direct per-document shares keep working; the effective role is the stronger of the two. The same effort also closes an existing attribution gap: document shares carry no record of who granted them, so the admin sharing view cannot say who granted a share.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A team shares documents by sharing a space (Priority: P1)

Priya creates a space named "Platform" and invites her three teammates by email, two as editors and one as a viewer. Each teammate sees the space appear in their document list. Priya moves five existing design documents into the space; from that moment every member can open all five at their space role — no per-document sharing happened. When Priya creates a new document while viewing the space, it lands in the space and is immediately visible to all members. Documents she does not move stay personal and invisible to the space.

**Why this priority**: This is the feature — replacing N×M per-document shares with one membership grant. Everything else refines it.

**Independent Test**: Create a space, invite an existing account at editor, move a document in, and verify the invitee can list, open, search for, and edit that document with no direct share row, while a non-member cannot see it anywhere.

**Acceptance Scenarios**:

1. **Given** any signed-in user, **When** they create a space with a valid name, **Then** the space exists and they are its sole member with the owner role.
2. **Given** a space owner and a teammate with an existing account, **When** the owner invites the teammate's email at editor, **Then** the teammate is a member immediately, is notified by email (subject to the inviter's outbound-email setting), and sees the space in their document list.
3. **Given** a member who directly owns a document and holds editor-or-better membership in a space, **When** they move the document into the space, **Then** every member can immediately open it at their space role, and it appears in each member's document list under that space.
4. **Given** a space document and a space member with the viewer role, **When** they open the document, **Then** they can read but not edit it, matching the existing viewer experience on directly shared documents.
5. **Given** a member viewing a space, **When** they create a new document, **Then** the document's home is that space, all members can reach it at their space role, and the creator additionally holds a direct owner share so their own access never depends on membership.
6. **Given** a user who is not a member of a space and holds no direct share on its documents, **When** they browse, search, or request those documents or the space itself, **Then** nothing about the space or its documents is visible or reachable.
7. **Given** an empty space, **When** a member views it, **Then** it offers "Move documents here" and "New document".

---

### User Story 2 - Direct shares and space access combine; the stronger wins (Priority: P1)

Liz already has a direct editor share on a document. The document moves into a space where Liz is only a viewer member — she keeps editing (direct share is stronger). Meanwhile Omar, a space-owner member, holds the owner role on every document in the space through passthrough: he can delete space documents, manage their direct shares, and move them out, even ones he never touched before. A contractor outside the space gets a direct viewer share on one space document and sees only that document.

**Why this priority**: The union + passthrough permission model (D3, D5) is the correctness core; every surface (list, open, search, realtime, agent) must agree on it or documents will be readable in some surfaces and invisible in others.

**Independent Test**: Construct one document with the direct-role × space-role matrix (each of none/viewer/editor/owner crossed) and verify the effective role on every access surface is the stronger of the two, including owner-via-space-passthrough being able to delete.

**Acceptance Scenarios**:

1. **Given** a user with a direct editor share on a document that is in a space where they are a viewer member, **When** they open the document, **Then** they can edit (stronger role wins).
2. **Given** a user with no direct share who is an editor member of a document's space, **When** they access the document through any surface (document list, direct open, keyword search, semantic search, realtime editing, agent tooling acting for them), **Then** every surface grants exactly editor.
3. **Given** a space-owner member with no direct share on a space document, **When** they attempt owner-only operations (delete the document, manage its direct shares, move it out), **Then** the operations succeed (uncapped passthrough, D5).
4. **Given** a space member below space owner with no direct owner share on a document, **When** they attempt to delete it, **Then** deletion is refused (delete still requires the owner role, D6).
5. **Given** a document in a space, **When** a member with at least viewer role shares it directly with a non-member, **Then** the grant succeeds at up to the sharing thresholds unchanged from today (D6), the non-member sees only that document, and the grant appears in the document's share list with the grantor recorded.
6. **Given** a viewer-only space member, **When** an agent authenticated with that user's token accesses a space document, **Then** the agent gets exactly the viewer role — agent surfaces mirror the owner's effective role with no token-side changes.

---

### User Story 3 - Documents move in and out; access follows, shares survive (Priority: P2)

Priya moves a document out of the space back to personal: members lose the space-derived access, but Liz's direct editor share keeps working. Omar (space owner, not the document's owner) ejects a stale document from the space — curation without gaining personal content rights over it. A member being removed mid-edit loses their live editing session within a minute.

**Why this priority**: Movement (D7) is how documents enter and leave the shared surface; getting the revocation half wrong silently leaks access.

**Independent Test**: Move a document out while a member with no direct share has it open; verify their live connection degrades or disconnects within about a minute and subsequent requests are refused, while a direct-share holder is unaffected.

**Acceptance Scenarios**:

1. **Given** a document in a space, **When** its direct owner moves it out to personal, **Then** members without direct shares immediately lose access on new requests, and any live connections they hold degrade or disconnect within about a minute.
2. **Given** the same move, **When** a member who also holds a direct share opens the document afterwards, **Then** their direct-share access is intact — a move never changes direct shares.
3. **Given** a space owner who does not directly own a document in the space, **When** they move it out to personal, **Then** the move succeeds (curation), and their own access afterwards is whatever direct shares give them — possibly none.
4. **Given** a user who directly owns a document but is only a viewer member of a target space, **When** they attempt to move the document in, **Then** the move is refused (move-in requires editor-or-owner membership in the target, D7).
5. **Given** a user who is an editor member of a target space but does not directly own the document, **When** they attempt to move it in, **Then** the move is refused (move-in requires a direct owner share, D7) — even a space-owner's passthrough owner role does not satisfy it.
6. **Given** a document in space A and a mover who satisfies both the move-out rule for A and the move-in rule for space B, **When** they move it from A to B, **Then** the move succeeds in one step; a mover who only satisfies the space-owner curation path can only target personal.
7. **Given** a member removed from a space mid-edit, **When** the removal lands, **Then** their live session on space documents degrades or disconnects within about a minute, while any direct shares they hold survive.

---

### User Story 4 - Running a space: invites, roles, leaving, deletion (Priority: P2)

Priya invites an address that has no account yet; the person receives an invite email, signs up later, and finds themselves a member at the invited role on first login. Priya promotes a teammate to owner (ownership transfer), then steps down. A member leaves; the last owner cannot leave without first promoting someone or deleting the space. Deleting the space reverts its documents to personal — nothing is ever deleted by deleting a space.

**Why this priority**: Space lifecycle and membership administration make the P1 stories operable day-to-day, but each P1 story is independently valuable without them.

**Independent Test**: Exercise the full membership lifecycle — invite unknown email, convert at first signup, re-invite at higher role, promote to owner, leave, delete space — and verify each transition's access effects.

**Acceptance Scenarios**:

1. **Given** an invite to an email with no account, **When** that person first logs in, **Then** they are a member at the invited role, the pending invite is consumed, and conversion never downgrades a membership they already acquired some other way.
2. **Given** an existing member at viewer, **When** any member re-invites them at editor, **Then** their role is raised; **When** re-invited at viewer or lower, **Then** nothing changes.
3. **Given** a member, **When** they invite someone at a role above their own, **Then** the invite is refused — a member can grant at most their own role; in particular, only a space owner can grant the space owner role.
4. **Given** a space owner, **When** they change a member's role or remove a member, **Then** it takes effect and the affected member's access to space documents changes accordingly, direct shares surviving.
5. **Given** a non-owner member, **When** they attempt rename, delete, member-role changes, member removal, or pending-invite revocation, **Then** the operation is refused.
6. **Given** the last remaining owner, **When** they attempt to leave, be removed, or be demoted, **Then** the operation is refused with guidance to first make another member owner or delete the space.
7. **Given** a space containing documents, **When** an owner deletes it, **Then** the confirmation states the document count, all documents revert to personal (never deleted), memberships and pending invites are removed, and former members retain only whatever direct shares they hold.
8. **Given** a pending invite, **When** a space owner revokes it by email, **Then** the address can no longer convert into membership at login.

---

### User Story 5 - Every share says who granted it (Priority: P3)

An admin reviewing a user's sharing detail sees, for every share, who granted it — instead of today's caveat that the grantor is unknowable. Shares that existed before this feature show the most likely grantor (the document's owner); every share created after it records the exact acting user, whether it came from the share dialog, an invite conversion, an agent tool, onboarding, or document creation itself.

**Why this priority**: An attribution closure (D8) riding along because the sharing surface is being touched anyway; valuable for audit but independent of the space experience.

**Independent Test**: After migration, verify no share row lacks a grantor; create shares through each write path (share dialog, invite conversion, agent share tool, onboarding welcome doc, document creation) and verify each records the acting user; view the admin sharing detail and see grantors displayed.

**Acceptance Scenarios**:

1. **Given** the migrated system, **When** any share row is inspected, **Then** it carries a grantor: pre-existing rows show the document's owner at migration time (falling back to the document's creator, then the share's own holder, where the owner account is gone), and rows written after migration show the exact acting user.
2. **Given** a share created through any write path — the share endpoint, pending-invite conversion (attributed to the original inviter), the agent share tool, onboarding's welcome document, or the owner row written at document creation (attributed to the creator) — **When** the row is inspected, **Then** the grantor is the acting user for that path.
3. **Given** the admin per-user sharing view, **When** an admin reviews a user's shares, **Then** each share displays its grantor and the "grantor unknown" caveat is gone.
4. **Given** space memberships, **When** any membership row is inspected, **Then** it likewise records who granted it, from the start.

## Edge Cases

- **Document creator leaves the space**: the document stays in the space; the creator keeps their direct owner share, so they can still open it, move it out, or delete it (design: Edge Cases).
- **Member removed mid-edit**: the periodic live-connection recheck downgrades or disconnects them within about a minute; direct shares survive (design: Edge Cases).
- **Space deleted while documents are open**: documents revert to personal; members without direct shares lose access on the same recheck cadence; document content, history, and direct shares are untouched.
- **Delete inside a space**: requires the owner role — held by direct owners and, through passthrough, space-owner members; members below space owner cannot delete documents they do not directly own.
- **Ownership transfer**: an owner sets another member to owner, then optionally steps down or leaves — no special mechanism.
- **Invite an address that is already a member** (including one's own): treated as a re-invite — raise if higher, otherwise no-op.
- **Invite an address that already has a pending invite**: the pending role is raised if the new role is higher, never lowered; still one pending invite per space per address, matched case-insensitively.
- **Move to the space a document is already in** (or personal-to-personal): succeeds as a no-op; no access or share changes.
- **Concurrent moves / stale move targets**: a move into a space that was deleted in the meantime fails cleanly; the document's home is always exactly one space or personal (D1) — never a dangling reference.
- **Space name at the boundary**: names are required, non-empty after trimming, and capped at 100 characters; duplicate names are allowed (spaces are identified by id, disambiguated by member list).
- **Grantor account deletion**: account deletion exists today (deleteUserByEmail, reached by the synthetic-account wipe and prod reset); the grantor reference is protected, so that path must first reassign granted rows to the document's current owner (same rule as the backfill) — deleting a granting account can never orphan or cascade-delete share rows, and the deletion enumeration itself must stay scoped to the account's directly-owned documents (space passthrough must never widen what a wipe deletes).
- **No-op invite email**: when the inviter has outbound email disabled, the membership or pending invite is still granted; only the mail is suppressed.
- **Search consistency**: a space document must appear in members' search results through every search path (keyword and semantic) and never in non-members' results — a missed path makes documents readable but undiscoverable, or worse, leaks titles/snippets.

## Requirements *(mandatory)*

### Functional Requirements

**Spaces and membership fundamentals (D1, D2)**

- **FR-001**: Any user MUST be able to create a space by giving it a name; the creator becomes the space's sole initial member with the owner role.
- **FR-002**: Every document MUST have exactly one home: the owner's personal area (the state of every document today) or exactly one space (D1). Space deletion MUST revert its documents to personal and MUST never delete them.
- **FR-003**: Space membership MUST reuse the existing three-tier role ladder (owner, editor, viewer) as the member's baseline role on every document in the space (D2).
- **FR-004**: Space names MUST be required, non-empty after trimming, and at most 100 characters, for both create and rename; duplicate names are permitted (RBD-053-1).

**Permission model (D3, D5, D6)**

- **FR-005**: A user's effective role on a document MUST be the stronger of their direct share role and their space role via the document's home (union, D3). Moving a document into a space never revokes an existing collaborator, and a space document can still be shared directly with someone outside the space.
- **FR-006**: The space role passes through uncapped (D5): a space-owner member holds the owner role on every document in the space, including deletion, direct-share management, and move-out. Unlike document sharing, where the owner role is never grantable, the space owner role is grantable — that is how a space gets more than one owner and how ownership transfer works.
- **FR-007**: Document-level operation thresholds MUST remain unchanged (D6): view needs viewer, edit needs editor, share needs viewer, manage needs editor, delete needs owner. A viewer member can therefore share a space document onward at viewer, and the grant appears in the document's share list.
- **FR-008**: Space-level operations MUST enforce the operations matrix: create a space — any user; invite a member at up to the inviter's own role — any member; change a member's role or remove a member — space owner; rename or delete the space — space owner; leave — any member except the last owner.
- **FR-009**: Because invites are capped at the inviter's own role, only an existing space owner can grant the space owner role — a deliberate grant of ownership over every current and future document in the space (D5).
- **FR-010**: The last owner MUST be protected across all paths: the last remaining owner cannot leave, be removed, or have their role lowered; the space must first gain another owner or be deleted (RBD-053-2 extends the design's leave rule to removal and demotion).

**Document movement (D7)**

- **FR-011**: Moving a document into a space MUST require that the mover holds a direct owner share on the document AND is an editor or owner member of the target space (D7). A passthrough owner role does not satisfy the direct-ownership half.
- **FR-012**: Moving a document out of a space to personal MUST be allowed to the document's direct owner or a space owner of the containing space; the space-owner path is curation and grants no content rights over the ejected document (D7).
- **FR-013**: A direct space-to-space move MUST satisfy both the move-out rule for the source and the move-in rule for the target; a mover relying solely on the space-owner curation path can only target personal (RBD-053-3).
- **FR-014**: A move MUST never change direct share rows; members who lose access lose only the space-derived part.
- **FR-015**: Access MUST follow a move immediately for new requests (list, search, open, and realtime access all derive at query time), and live connections MUST be re-verified on the existing periodic recheck so a revoked space grant degrades or disconnects a connected user within about a minute — the same machinery as direct-share revocation, no new mechanism.

**Invites and membership lifecycle (D4)**

- **FR-016**: Inviting MUST be by email only in v1 (D4); there are no join links.
- **FR-017**: Inviting an address with an existing account MUST add them as a member immediately and notify them by email.
- **FR-018**: Inviting an unknown address MUST create a pending invite and send an invite email; at that person's first login, pending invites MUST convert into memberships following the established conversion pattern — transactional, idempotent on conflict, and never downgrading an existing membership.
- **FR-019**: Re-inviting an existing member MUST raise their role if the invited role is higher and otherwise do nothing; re-inviting an already-pending address MUST likewise raise the pending role and never lower it (RBD-053-9).
- **FR-020**: A space MUST hold at most one pending invite per email address, matched case-insensitively.
- **FR-021**: Invite and membership emails MUST follow the existing outbound-mail gate: sends are suppressed unless the inviter has outbound email enabled, and the membership or pending invite is granted regardless. Mail goes through the existing email path with a space-invite template.
- **FR-022**: Any member except the last owner MUST be able to leave. Leaving or being removed deletes the membership; direct shares that member holds on space documents survive.
- **FR-023**: A space owner MUST be able to revoke a pending invite by email, after which the address can no longer convert into membership (RBD-053-4: owner-only).

**Space deletion**

- **FR-024**: Deleting a space MUST revert its documents to personal, remove memberships and pending invites, and never touch document content, direct shares, or history. The confirmation MUST state the document count.

**Access derivation — every surface (integration points)**

- **FR-025**: The central document-role resolution MUST become the effective-role union (direct share vs. space role), so that every per-document API operation, the realtime connection gate, and the periodic live-connection recheck all use it — one resolution, no surface-local variants.
- **FR-026**: The document-list query MUST gain the space leg: space documents appear for members, each listed document carries its space identity and name, and the list accepts a space filter (a specific space, personal-only, or all). When no filter is given the result is unchanged from today (all accessible documents).
- **FR-027**: Search MUST gain the space leg in all four of its independent permission joins (both keyword paths, the semantic path, and the outer query): space documents are findable by members through every search path and never surface for non-members. A missed leg makes space documents readable but absent from results.
- **FR-028**: Agent tools that today carry their own inline permission checks (sharing, title changes, version listing, version naming, agent presence) MUST be routed through the shared permission layer rather than each learning about spaces independently.
- **FR-029**: The agent share tool MUST converge with the standard share semantics as part of that rerouting (RBD-053-5): the shared permission threshold (viewer-can-share, D6) instead of owner-only, the pending-invite path for unknown addresses, notification email under the existing gate, and grantor recording — one sharing behavior across human and agent surfaces.
- **FR-030**: Admin and onboarding owned-document counting MUST remain based on direct ownership — spaces do not change who owns a document (ownership stays a direct share).
- **FR-031**: Realtime editing, presence and its dedup, and version history MUST behave exactly as before for space documents — spaces change who can reach a document, not what happens inside it; the role arrives through the existing connection gate.

**Grant attribution (D8)**

- **FR-032**: Every document share MUST record who granted it, with no exceptions after migration (the attribute is mandatory once the backfill has run).
- **FR-033**: Pre-existing shares MUST be backfilled with the document's current owner as grantor; where the owner account is gone, fall back to the document's creator, then to the share's own holder, so the mandatory constraint holds everywhere. Backfilled values record the most likely grantor, not a verified one; only rows written after this change are exact.
- **FR-034**: Every path that creates or updates a share MUST record the acting user as grantor: the share endpoint, pending-invite conversion (attributed to the original inviter, which the invite already carries), the agent share tool, onboarding's welcome-document owner row, and the owner row written at document creation (the creator).
- **FR-035**: The grantor reference MUST NOT cascade or nullify on account deletion. The existing deletion path (deleteUserByEmail, reached by the synthetic-account wipe and the prod reset endpoint) MUST first reassign rows the account granted to the document's current owner — the same rule as the backfill — before deleting the user row; its owned-document enumeration MUST remain scoped to direct owner shares so a space-owner wipe deletes only documents the account directly owns. (Amended 2026-08-07 per analyze findings I1/U1; design amended in the same pass.)
- **FR-036**: Space memberships MUST record their grantor from the start (mandatory, same reassignment rule); space invites record their inviter but tolerate the inviter's account disappearing, matching document share invites.
- **FR-037**: The admin per-user sharing view MUST display the grantor for each share, replacing the current "grantor unknowable" caveat.

**Service surface**

- **FR-038**: The service MUST expose space operations matching the design's REST surface: create a space; list my spaces (with member count and my role); space detail (members, pending invites, document count); rename; delete; invite a member by email at a role; change a member's role; remove a member (removing oneself is leaving); revoke a pending invite by email; move a document (target space or personal); and a space filter on the document list.
- **FR-039**: All space operations MUST enforce authentication and the operations matrix; users who are not members of a space MUST NOT be able to observe its existence, membership, or contents through any endpoint (RBD-053-10: membership required to read space detail; refusal indistinguishable from non-existence).

**Product surface**

- **FR-040**: The document list MUST present a space section list: the personal area ("My Docs") first, then one entry per space the user belongs to; the existing all / owned / shared-with-me filter applies within the selected scope, where "owned" continues to mean directly owned — passthrough does not reclassify documents as owned (RBD-053-7).
- **FR-041**: Document rows and the editor MUST offer a "Move to space" action to direct owners, targeting spaces where the user is an editor or owner member; the editor header MUST show the containing space as a small chip.
- **FR-042**: Each space MUST have a settings page: rename, member list with roles, an invite box with a role picker (reusing the existing user-search autocomplete), pending invites, and leave and delete actions — each control shown per the operations matrix.
- **FR-043**: The share dialog on a space document MUST remain unchanged for direct shares and additionally show a read-only line stating the space grant (for example "Everyone in Platform can edit (12 members)"), so the effective audience is visible.
- **FR-044**: Creating a document while viewing a space MUST set that space as its home at creation; the creator still gets a direct owner share, so their access never depends on their membership.
- **FR-045**: An empty space MUST offer "Move documents here" and "New document".
- **FR-048**: The UI MUST offer a way to create a space: the document list's scope selector ends with a "New space" action, and the move dialog offers the same action, creating and then moving the document in one step; creation lands on the space settings page. (Added 2026-08-07, Sam-reported: the original spec listed every space surface except the way to create one, so the feature shipped unreachable. Design amended in the same pass.)

**Agent surface**

- **FR-046**: Agent credentials (API tokens and OAuth delegations) MUST see exactly their owner's spaces with no credential-side changes — access is re-derived per request from the owner's effective roles.
- **FR-047**: The agent document-listing tool MUST include each document's space name and accept a space filter parameter (RBD-053-8: the design's "natural addition" is in scope for v1).

### Key Entities

- **Space**: a named container for documents with a member list; has a name (at most 100 characters), a creator, and a set of member and pending-invite records. Identified by id; names need not be unique.
- **Space membership**: (space, user, role, granted-by); role is the baseline on every document in the space; at most one membership per user per space; who granted it is always recorded.
- **Space invite**: (space, email, role, inviter); a pending grant for an address with no account yet, one per space per address (case-insensitive), converted to a membership at first login; the inviter reference tolerates account disappearance.
- **Document home**: each document's single location — personal (no space) or exactly one space; moving is a change of home and nothing else; space deletion reverts homes to personal.
- **Effective role**: the per-user, per-document outcome of the union — the stronger of the direct share role and the space role; the single truth consulted by every access surface.
- **Share grant attribution**: the acting user recorded on every document share and space membership; backfilled for pre-existing shares with the document's owner (creator, then holder, as fallbacks).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A team of M members gains access to N documents with exactly one space, M invites, and N moves — instead of N×M individual shares — and every member can list, open, search for, and (at editor) edit every space document with zero direct share rows created for them.
- **SC-002**: Across the full direct-role × space-role matrix, every access surface (document list, direct open, keyword search, semantic search, realtime editing, agent tooling) reports the identical effective role — the stronger of the two — with zero surface disagreements.
- **SC-003**: After a document leaves a space (move-out or space deletion), members without direct shares are refused on their next request, and 100% of their live connections degrade or disconnect within about a minute; direct-share holders are unaffected in 100% of cases.
- **SC-004**: Space documents never appear in any list, search result, or space detail for non-members: zero leakage across all query paths, verified for both keyword and semantic search.
- **SC-005**: After migration, 100% of document share rows carry a grantor; every share-creating path records the exact acting user; and the admin sharing view shows a grantor for every share with the "unknowable" caveat gone.
- **SC-006**: An invite to an address with no account converts to a membership at the invited role on first login in 100% of cases, and never downgrades a membership acquired in the meantime.
- **SC-007**: For documents not in any space, behavior is unchanged end to end: access decisions, list contents, search results, sharing, realtime, history, and agent surfaces produce the same outcomes as before the feature (regression guarantee for the all-personal status quo).
- **SC-008**: A user can create a space, invite a teammate, and move a document in within two minutes of first encountering the feature, with no documentation.

## Assumptions

- The design doc `design/spaces.md` (Ratified 2026-08-07) is authoritative; decisions D1–D8 are encoded here, not re-decided. D7's move rules are ratified as a starting point and may be revised once spaces are in use — this spec encodes today's ratified rules.
- The existing role ladder (owner/editor/viewer), sharing thresholds, invite-conversion pattern, outbound-email gate, user-search autocomplete, and the periodic live-connection recheck are reused as-is; this feature adds the space leg to existing machinery, not new mechanisms.
- Realtime, presence, and version history are untouched: rooms are per document, identity is per principal, and the role arrives through the existing connection gate.
- Schema changes are additive (three new tables, two new columns) and go through the standard migration pipeline; new migration timestamps must exceed 1795000000000 (phantom migration row from the rolled-back feature 008 — recorded project constraint, restated by the design doc).
- No numeric caps (spaces per user, members per space, pending invites) are introduced in v1 (RBD-053-6); the platform's existing rate-limiting posture applies unchanged.
- When the document list is asked for without a space filter, the result is all accessible documents — identical to today (back-compat default for the new filter).
- Only the space-invite email template is new; no other notifications (rename, removal, deletion, move) are introduced — per-space notification settings are an explicit non-goal.
- Attribution semantics for edits are unchanged: spaces alter reachability, never authorship or provenance (Constitution Principle IV).

## Out of Scope *(from the design's Non-Goals — deferred, not rejected)*

- Join links: a join URL would be the product's first bearer-token access grant and needs its own security review.
- Folders or any hierarchy inside a space.
- Space-scoped API tokens (agent credentials stay user-scoped).
- Per-space notification settings.
- Auto-join by email domain, and org constructs above spaces.
- A space-centric admin view: v1 only adds space names to the existing per-user sharing detail on the admin page.
- Changing document-level role thresholds (D6 keeps them; revisiting viewer-can-share is explicitly not this feature).
- New account-deletion mechanisms (the existing deleteUserByEmail path is adapted per FR-035; no new deletion surface is built here).
