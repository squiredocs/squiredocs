# Clarifications ledger — 035-per-user-model-override (spec phase)

Per the parallel-agent rules: no user interaction; each open product decision got the best
default and is recorded here as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-25)**.
Overturn any of these by amending the spec before plan/implement consumes it.

Design ground truth: `design/in-app-ai-assistant.md` — the amended "Model resolution"
sentence and the "Per-user model override (035)" paragraph — plus the Admin area
capabilities list in `design/authentication-and-sharing.md`. The design already fixes the
core semantics (storage as `users.chat_model_override`, NULL = dynamic default, precedence
slot between BYOK and shared default, derived eligibility, resolution-time fallback,
admin-only, invisible to the affected user); the decisions below cover the points it leaves
under-specified.

## RATIFIED-BY-DEFAULT decisions

1. **Write-time validation in addition to resolution-time fallback** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-25).
   *Question*: does the management endpoint accept any string and rely on the resolution-time
   fallback, or reject bad keys up front?
   *Why it matters*: accepting garbage would make every bad admin input a silent no-op that
   only shows up as per-turn fallback logs.
   *Rationale*: reject unknown/ineligible keys at write time with a clear error (mirroring
   the shared-default PUT endpoint's existing behavior), while keeping the resolution-time
   fallback for values that *become* ineligible after storage. Explicit in Sam's scope
   guidance. Spec: FR-006/FR-007.

2. **Ineligible stored overrides are kept, never auto-cleared** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-25).
   *Question*: when a stored override goes stale (model removed from registry, provider's
   shared key withdrawn), is the stored value deleted or retained?
   *Why it matters*: auto-clearing loses admin intent permanently on what may be a temporary
   deployment condition (e.g. a key briefly unset).
   *Rationale*: fallback is evaluated per turn against current eligibility; the stored value
   stays put and resumes working if eligibility returns. Matches how the shared-default
   setting already behaves under key removal (026 FR-005/D4). Spec: FR-006, Edge Cases.

3. **Admin UI placement: per-user picker in the expanded row of the admin user list,
   reusing the shared-default picker's eligible-model payload** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-25).
   *Question*: where does the control live and where does its model list come from?
   *Why it matters*: the design says only "from the admin user list"; a second hand-curated
   model list would drift from the shared-default picker.
   *Rationale*: the user list already has an expanded per-user detail area (credits, sharing,
   034 metadata) — this is the established home for per-user admin controls; the eligible
   list (models + provider grouping) is single-sourced from the same enumeration the
   shared-default picker uses. Spec: FR-009, Assumptions.

4. **Stale override display: show stored-but-unavailable state, mirroring the
   shared-default picker** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-25).
   *Question*: what does the admin see for a user whose stored override is currently
   ineligible?
   *Why it matters*: displaying "Default" would misrepresent stored state; hiding it would
   make the stored value uneditable.
   *Rationale*: reuse the existing pattern from the shared-default picker (stored key shown
   as a disabled "unavailable — using X" option) so the admin sees both the stored intent
   and the effective outcome. Spec: FR-010, Edge Cases.

5. **Override may be set/cleared while the user's BYOK is active (dormant override)** —
   RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-25).
   *Question*: is setting an override on a BYOK-active user rejected, or stored dormant?
   *Why it matters*: BYOK is user-controlled and can toggle at any time; rejecting would make
   the admin's ability to pre-position an override depend on a state the admin doesn't
   control.
   *Rationale*: store it; it has no effect while BYOK is active (BYOK-wins is absolute) and
   takes effect when the user leaves BYOK. Spec: FR-003/FR-015, US3.

6. **Effect timing: next assistant turn, via per-turn read of the stored value** —
   RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-25).
   *Question*: when does a set/clear take effect, and is any cache involved?
   *Why it matters*: a cached override would resurrect the multi-replica staleness problem
   the shared default already had to solve (021 MEDIUM-2 pattern); a session-scoped read
   would require re-login.
   *Rationale*: the chat path already reads the user's per-turn settings (BYOK row) from the
   database on every turn; the override rides the same per-turn read, so changes apply on
   the very next turn with no new cache and no re-login. In-flight turns finish on the model
   they started with. Spec: FR-012, Edge Cases.

7. **Metering, credits, and quotas are unchanged** — RATIFIED-BY-DEFAULT (Sam
   pre-authorized, 2026-07-25).
   *Question*: does an overridden user meter differently?
   *Why it matters*: the override can point at a more or less expensive model; someone might
   expect per-user pricing to follow.
   *Rationale*: an overridden turn is an ordinary shared-key turn on the resolved model —
   existing cache-aware pricing already charges by the model actually used; nothing else
   changes. The design doc's credits section is untouched by the 035 amendment. Spec: FR-014.

8. **No special-casing for the admin's own account** — RATIFIED-BY-DEFAULT (Sam
   pre-authorized, 2026-07-25).
   *Question*: can the admin pin a model for themselves?
   *Why it matters*: self-service model choice for the admin is a handy trial mechanism
   (e.g. dogfooding a new gateway model before making it the shared default).
   *Rationale*: the override is just a users-table column; excluding the admin would add
   code for no benefit. Spec: Edge Cases.

## Plan-phase decisions (added 2026-07-26 by the plan agent)

9. **Resolution helper lives in `chat-models.js`; `resolveChatModel` gains one optional
   parameter** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-25).
   *Question*: where does the override→shared-default fall-through logic live, and how does it
   reach `resolveChatModel`?
   *Why it matters*: splitting one link of the precedence chain away from the other four is how
   the chain drifts from the design doc's single sentence.
   *Rationale*: a pure `resolveUserChatModelKey(overrideKey, sharedDefaultKey)` sits directly
   above `resolveChatModel` in the same file (mirroring `resolveSharedDefaultKey`'s shape), and
   `resolveChatModel` takes an optional `userOverrideKey` used **only** in its non-BYOK branch.
   The BYOK branch is untouched, so BYOK-wins and byok-misconfigured-never-falls-back hold
   structurally rather than by remembering a rule. No refactor (assignment constraint).
   Plan: research R1, contracts/model-resolution.md C1/C2.

10. **The override rides the existing per-turn `loadByokSettings` SELECT** —
    RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-25).
    *Question*: how does the chat path read the stored value each turn?
    *Why it matters*: any cache reintroduces multi-replica staleness; a second query costs a
    round trip per turn.
    *Rationale*: `chat.js` already loads the user's settings row on every turn via
    `loadByokSettings`; `chat_model_override` joins that column list. Accepted cost: a function
    named for BYOK now returns a non-BYOK column — documented with a comment and pinned by a
    non-disclosure test, but **not** renamed (that would be a cross-file refactor). Flagged as
    a MEDIUM for the implement brief. Plan: research R3, contract C3.

11. **Admin endpoint: `PATCH /api/admin/users/:userId/chat-model`, body
    `{ modelKey: string|null }`, no new list endpoint** — RATIFIED-BY-DEFAULT (Sam
    pre-authorized, 2026-07-25).
    *Question*: what shape does the management surface take?
    *Why it matters*: a second eligible-model endpoint is exactly the drift decision 3 forbids.
    *Rationale*: mirrors the neighbouring `PATCH /users/:userId/credit` and `/email-enabled`
    handlers (validate → `UPDATE … RETURNING` → 404 on no rows) and the shared-default PUT's
    two-branch validation messages; the eligible list comes from the `GET /settings/shared-model`
    payload the admin page already fetches. Response returns the stored value plus the
    resulting `effectiveModelKey`. Plan: research R4, contracts/admin-chat-model-api.md A1.

12. **No per-user `effectiveModelKey` on the `GET /users` list payload** — RATIFIED-BY-DEFAULT
    (Sam pre-authorized, 2026-07-25).
    *Question*: does the user list carry a server-computed effective model per row?
    *Why it matters*: it would run the resolver once per account on every admin page load for
    information the client can already derive.
    *Rationale*: the row carries only `chatModelOverride`; the client derives the effective
    label from the shared-model payload it already holds — the same derivation the shared-default
    picker performs today. The PATCH response *does* return `effectiveModelKey`, which is where
    it is actually needed (post-write reconciliation). Plan: research R4, contract A2.

## Flagged design gaps (Principle VI)

- **UI placement under-specified**: the design says "from the admin user list" but not
  where in it; decision 3 records the expanded-row default. If Sam wants it as a visible
  column instead (like credits), amend before implement.
- **Write-time validation not in the design doc**: the design specifies only resolution-time
  fallback; write-time rejection comes from Sam's scope guidance (decision 1). The design
  doc's 035 paragraph could mention it for completeness when next amended — not blocking.
- **Stale-override retention not stated**: the design specifies the fallback but not whether
  the stored value survives; decision 2 records keep-and-fallback. Worth a clause in the
  design paragraph on next amendment — not blocking.
- **Naming drift in the orchestrator brief (informational)**: the eligibility function in
  `server/api/chat-models.js` is `isSharedEligible` (~line 317), not `canBackSharedDefault`
  as the feature brief called it. Same rule, different name; no design change needed.
- **Admin visibility of BYOK dormancy**: the design doesn't say whether the admin picker
  should hint that a user's override is currently dormant because BYOK is active. The spec
  does not require such a hint (kept minimal); the admin can already see BYOK state is
  user-private. If desired, this is a plan-time UI nicety, not a spec change.
