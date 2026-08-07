# Clarifications ledger — 053-spaces (spec phase)

Per the parallel-agent rules: no user interaction; each open product decision got the best
default and is recorded here as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07)**.
Overturn any of these by amending the spec before plan/implement consumes it.

Design ground truth: `design/spaces.md` — "Squire Spaces (Shared Team Workspaces)",
Ratified 2026-08-07 (Sam). Constitution Principle VI applies: the design doc wins over
code, priors, and judgment.

## Already ratified by Sam (2026-08-07) — recorded, not defaults

Decisions D1–D8 are **RATIFIED BY SAM** in the design doc's Decisions ledger and are
encoded in the spec verbatim, not relitigated:

- **D1** One home per document (personal or exactly one space; space deletion reverts to
  personal). Spec: FR-002.
- **D2** Space membership reuses the doc-role ladder (owner/editor/viewer). Spec: FR-003.
- **D3** Union model: effective role is the stronger of direct share and space role; a
  move never revokes access. Spec: FR-005, FR-014, US2.
- **D4** Email invites only in v1; no join links. Spec: FR-016, Out of Scope.
- **D5** Uncapped passthrough: a space-owner member holds owner on every space document,
  including deletion, direct-share management, and move-out; the space owner role is
  grantable by an existing space owner. Spec: FR-006, FR-009, US2.
- **D6** Document-level REQUIRED_ROLES unchanged (viewer can share onward, editor can
  manage shares, delete needs owner). Spec: FR-007.
- **D7** Move-in requires direct document ownership plus editor-or-owner membership in
  the target; move-out requires document ownership or space ownership. Ratified as a
  starting point, open to revision once spaces are in use. Spec: FR-011, FR-012, US3.
- **D8** granted_by added to document_shares as NOT NULL after a backfill keyed to the
  document's owner (creator_id, then the share's own user_id as fallbacks); every new
  grant records the acting user. Spec: FR-032..FR-037, US5.

## RATIFIED-BY-DEFAULT decisions

1. **RBD-053-1 — Space name validation: required, trimmed non-empty, ≤100 chars,
   duplicates allowed** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07).
   *Question*: the schema says `name varchar(100) not null`; are empty/whitespace names
   valid, and must names be unique?
   *Why it matters*: an empty-named space is unusable UI; a uniqueness constraint would
   surprise users who name a space like everyone else does ("Design", "Platform").
   *Rationale*: the design constrains only length and NOT NULL. Trimmed-non-empty is the
   minimum that keeps the UI usable; no uniqueness constraint appears in the schema, and
   spaces are identified by id with the member list disambiguating. Applies to rename
   too. Spec: FR-004, edge case "Space name at the boundary".

2. **RBD-053-2 — Last-owner protection extends to removal and demotion, not just
   leaving** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07).
   *Question*: the design forbids the last owner *leaving*; may a last owner demote
   themselves to editor, and (vacuously today, since only owners change roles) can the
   last owner row be removed or downgraded by any path?
   *Why it matters*: a space whose last owner demoted themselves has no one who can
   rename, delete, manage members, or promote a new owner — a permanently orphaned space.
   *Rationale*: the leave rule exists precisely to guarantee every space always has an
   owner; demotion and removal reach the same ownerless state by another door, so the
   invariant ("a space always has at least one owner") is what the design must mean.
   Refusal carries the same guidance as the leave rule: promote another member or delete
   the space. Spec: FR-010, US4 scenario 6.

3. **RBD-053-3 — A space-to-space move must satisfy both the move-out and move-in rules;
   the space-owner curation path targets personal only** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-08-07).
   *Question*: move-out is allowed "to personal, or to another space the mover can add
   to" — what exactly must a mover hold for a one-step A→B move, and can a space owner
   who is not the direct owner eject a document into another space?
   *Why it matters*: if the curation path could target another space, a space owner could
   move someone else's document into a space of their choosing — gaining passthrough
   owner rights over it there, contradicting "ejecting without gaining content rights".
   *Rationale*: "a space the mover can add to" reads as the move-in rule (direct owner
   share + editor/owner membership in the target, D7); composing both rules is the only
   reading where every move-in, however reached, satisfies D7. The curation path grants
   no content rights, so its only legitimate target is personal. Spec: FR-013, US3
   scenario 6.

4. **RBD-053-4 — Revoking a pending invite requires the space owner role** —
   RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07).
   *Question*: the REST surface lists `DELETE /api/spaces/:id/invites` but the operations
   matrix does not say who may revoke a pending invite.
   *Why it matters*: any-member revocation would let a viewer silently cancel an owner's
   pending grant; unstated permissions become accidental permissions.
   *Rationale*: revoking a pending invite is the pre-account analog of "remove a member",
   which the matrix assigns to the space owner. Owner-only is the conservative default
   and matches the settings-page framing (pending invites listed alongside member
   management). Spec: FR-023, US4 scenarios 5 and 8.

5. **RBD-053-5 — The agent share tool converges fully with REST share semantics** —
   RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07).
   *Question*: the design says the agent share tool "is already stricter than the REST
   endpoint (owner-only, no invite path, no email); converging it is part of this work" —
   converge on which of the three gaps?
   *Why it matters*: converging only the permission threshold would leave two sharing
   behaviors (agents can't invite unknown emails, recipients get no mail), and the spec
   must say which behavior is the contract.
   *Rationale*: the design enumerates all three differences in the same sentence that
   mandates convergence; picking a subset would preserve exactly the divergence the
   sentence exists to close. Full convergence: shared permission threshold
   (viewer-can-share, D6), pending-invite path for unknown addresses, notification email
   under the existing email_enabled gate, and grantor recording (D8 already requires the
   last). Spec: FR-029.

6. **RBD-053-6 — No numeric caps in v1 (spaces per user, members per space, pending
   invites per space)** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07).
   *Question*: should creation/invite endpoints enforce quantity limits?
   *Why it matters*: caps are a scope decision; retrofitting them is easy, retrofitting
   their absence is not.
   *Rationale*: the design specifies none, and the product's recent posture removed
   sign-up caps and raised token caps rather than adding limits (Sam, 2026-07-18).
   Existing platform rate limiting applies unchanged; per-object caps would be ceremony
   without a concrete failure they prevent (Constitution Principle III). Spec:
   Assumptions.

7. **RBD-053-7 — The "owned" list filter keeps meaning directly owned; passthrough does
   not reclassify** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07).
   *Question*: a space-owner member holds the effective owner role on every space
   document (D5) — do those documents now appear under the "owned" filter and in
   owned-document counts?
   *Why it matters*: two defensible readings ("owned" = effective owner role vs. holds a
   direct owner share) yield different lists, counts, and admin numbers.
   *Rationale*: the design's integration note is explicit for admin/onboarding counting —
   "Spaces do not affect them (ownership stays a direct share)" — and a list filter that
   disagreed with every ownership count would be incoherent. Effective role governs what
   you can *do*; direct ownership governs what is *yours*. Spec: FR-030, FR-040.

8. **RBD-053-8 — The agent document-listing space filter is in scope for v1** —
   RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07).
   *Question*: the Agent Surface section says list results "gain the space name, and a
   space filter parameter is a natural addition" — is the filter v1 or deferred?
   *Why it matters*: it is the difference between agents being able to scope work to a
   space and having to client-side filter every listing.
   *Rationale*: the sentence sits in the in-scope section (deferred items are explicitly
   marked, e.g. space-scoped tokens "are deferred" in the same paragraph); the REST list
   gains the same filter, and agent/human surface parity is the feature's own theme.
   Spec: FR-047.

9. **RBD-053-9 — Re-inviting an already-pending address raises the pending role, never
   lowers it** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07).
   *Question*: the design defines re-invite semantics for existing members
   (raise-if-higher, else no-op) but not for an address that already holds a pending
   invite.
   *Why it matters*: with a unique (space, email) pending row, a second invite must
   either error, overwrite, or merge — and overwrite would let a later, lower invite
   silently downgrade an earlier grant before the person ever logs in.
   *Rationale*: symmetry with both stated rules — members raise-if-higher, and
   "a pending invite never downgrades an existing membership" at conversion; monotone
   pending roles are the only behavior consistent with both. Spec: FR-019, FR-020, edge
   case "already has a pending invite".

10. **RBD-053-10 — Space visibility requires membership; refusal is indistinguishable
    from non-existence** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07).
    *Question*: who may read a space's detail (name, member list, pending invites,
    document count), and what does a non-member get?
    *Why it matters*: member lists and pending-invite emails are personal data; a
    distinguishable "exists but forbidden" response confirms space ids and invites
    enumeration.
    *Rationale*: matches the product's existing document-access posture (non-access is
    presented as non-existence) and the design's framing that members "see the space in
    their document list" — nobody else is ever shown one. Listing "my spaces" is by
    construction membership-scoped. Spec: FR-039, US1 scenario 6.

## RATIFIED-BY-DEFAULT decisions added at plan time (2026-08-07)

11. **RBD-053-11 — The design's "there is no account-deletion path today" is FALSE; the
    grantor reassignment rule is applied to the path that exists** — RATIFIED-BY-DEFAULT
    (Sam pre-authorized, 2026-08-07). **FLAGGED FOR SAM — needs a design-doc amendment.**
    *Question*: `design/spaces.md` (granted_by section) and spec FR-035 both assert there is
    no account-deletion path, and defer the reassignment rule to a hypothetical future one.
    But `deleteUserByEmail()` exists at `server/auth/users.js:335-386` (feature 029),
    reachable in production via `server/auth/routes.js:758` (synthetic-namespace wipe) and
    `:824` (the prod single-account reset), and covered by
    `server/__tests__/integration/faucet-wipe.test.js` and `prod-reset.test.js`. What
    happens when `granted_by` is NOT NULL with `ON DELETE NO ACTION`?
    *Why it matters*: that helper's final `DELETE FROM users WHERE id = $1` raises a foreign
    key violation whenever the deleted account granted a share on a document it does not
    own — reachable today, because `REQUIRED_ROLES.share = 'viewer'`
    (`server/permissions.js:17`) lets any collaborator share onward. The transaction rolls
    back and the wipe/reset fails. Shipping D8 without touching that path breaks a working
    production capability.
    *Rationale*: the design already prescribes the remedy for exactly this situation
    ("it must first reassign rows the account granted to the document's current owner, the
    same rule as the backfill"). Applying the design's own stated rule to the path that
    exists is the smallest change that keeps both D8 and feature 029 true, and it invents
    nothing. Two `UPDATE`s inside the existing transaction, immediately before the user
    delete (SQL in `contracts/share-attribution.md` §5).
    *Conflict recorded*: the spec's Out of Scope says the opposite — "Any account-deletion
    mechanism (the grantor reassignment rule is stated for a future path, not built here)".
    That line and the design sentence both need correcting; reported as a HIGH finding by
    the plan-phase analyze pass rather than resolved silently. Plan: LOUD FLAG 2.

12. **RBD-053-12 — Effective role is computed on integer ranks; `GREATEST()` over the
    `doc_role` enum is forbidden** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07).
    *Question*: the design states the permission model as
    `GREATEST(direct role, space role)`. Is that literal SQL?
    *Why it matters*: `doc_role` was created as
    `pgm.createType('doc_role', ['owner','editor','viewer'])`
    (`migrations/006_add_role_to_shares.js:10`), and PostgreSQL orders an enum by
    declaration order — so the enum collates `owner < editor < viewer`, the exact inverse
    of the privilege ladder `{owner:3, editor:2, viewer:1}` (`server/documents.js:7-11`).
    `GREATEST('owner','viewer')` returns `'viewer'`. Taken literally, the design's formula
    strips a direct owner of their own document whenever a viewer-level space role exists.
    *Rationale*: the design states the *semantics* ("the stronger one wins"), not a literal
    query. The ranks are the existing, tested expression of "stronger". The mapping happens
    once, inside the `document_access` view; nowhere else in the feature may order,
    `MAX()`, or `GREATEST()` a `doc_role` value. Asserted executably by a test so the
    hazard cannot be "cleaned up" back in. Plan: LOUD FLAG 1; research R2.

13. **RBD-053-13 — Invite conversion falls back to the document owner, then the invitee,
    when the inviter is unknown** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07).
    *Question*: the design says invite conversion records the grantor "from
    `invited_by_user_id`, which the invite row already carries". But
    `document_share_invites.invited_by_user_id` is NULLABLE with `ON DELETE SET NULL`
    (`migrations/1787000000000:12-51`) while `granted_by` is NOT NULL. What is written when
    the inviter's account is gone?
    *Why it matters*: `convertPendingInvites` runs on **every** login
    (`server/auth/users.js:97`) and is contractually forbidden to throw
    (`:105-107`). A NOT NULL violation there would be a login-time failure for the affected
    user, silently swallowed, leaving them without the access they were invited to.
    *Rationale*: reuse the backfill's own chain, which the design defines for exactly this
    "the grantor is unknowable" case: inviter → the document's current owner → the share's
    own holder. Consistency with FR-033 means one rule, not two. Spec: FR-034 (its
    "attributed to the original inviter" wording assumes the inviter survives).

14. **RBD-053-14 — Search's `owned` / `shared_with_me` filters mean DIRECT ownership, like
    the list's** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07).
    *Question*: RBD-053-7 settled the *document list* filter. `server/search.js` has its own
    `buildRoleCondition` (`:87-91`) applied at all four permission joins; the spec's FR-040
    speaks only of the list.
    *Why it matters*: if search's "owned" meant effective-owner while the list's meant
    direct-owner, the same filter word would produce different result sets in two adjacent
    UI surfaces, and neither would match the admin's owned-document count.
    *Rationale*: RBD-053-7's reasoning ("effective role governs what you can *do*; direct
    ownership governs what is *yours*") is not list-specific. Extending it is the only
    coherent reading. Spec: FR-027 with FR-040; research R9.

15. **RBD-053-15 — Share count, the share dialog's member list, and the share autocomplete
    stay direct-share-only; the space audience is a separate read-only line** —
    RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07).
    *Question*: three existing surfaces count or list `document_shares` rows —
    `share_count` (`server/documents.js:250`, `server/search.js:319`), `getDocumentUsers`
    (`server/documents.js:155-174`, which powers the share panel), and the autocomplete's
    already-has-access exclusion (`server/documents.js:312`). Do space members join them?
    *Why it matters*: folding a 40-member space into a document's share badge would make
    every space document look mass-shared, and putting space members in the share panel's
    editable list would imply per-document role controls that do not exist for them.
    *Rationale*: the design is explicit that the share dialog is "unchanged for direct
    shares, plus a read-only line stating the space grant" — one line, not a merged list.
    The badge and the autocomplete exclusion follow the same boundary. Spec: FR-043.

16. **RBD-053-16 — Pending-invite email addresses are visible to all space members in the
    space detail** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-07, recorded by the
    orchestrator resolving analyze finding U2).
    *Question*: the space detail returns members and pending invites; pending rows carry
    third-party email addresses. Do all members see them, or owners only?
    *Why it matters*: RBD-053-10 settled who can see the space, not which members see
    invitee addresses; leaving it implicit ships a privacy decision nobody made.
    *Rationale*: consistency with the document share surface, where anyone with view can
    list a document's shares and pending invites (GET /api/docs/:docId/shares requires
    only the share threshold). A stricter owners-only rule would make the space surface
    the odd one out; if Sam wants it tightened, it is a one-line filter in the detail
    endpoint.

## Explicitly deferred (flagged, not decided here)

- **Non-goals list** (design): join links, folders, space-scoped tokens, per-space
  notifications, domain auto-join/orgs, space-centric admin view — carried into the
  spec's Out of Scope verbatim.
- **D7 revision**: Sam ratified the move rules "as a starting point, open to revision
  once spaces are in use". Any loosening (e.g. letting editors move documents in) is a
  design-doc amendment first, not a spec change.
- **Account deletion**: superseded 2026-08-07 by analyze findings I1/I2 — deleteUserByEmail
  already exists (synthetic wipe + prod reset), so FR-035 now requires the reassignment
  rule on that existing path (design amended in the same pass). Building any new deletion
  surface stays out of scope.
