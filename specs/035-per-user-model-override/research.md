# Phase 0 Research — Per-User Chat Model Override (035)

All six decisions below were resolved against the *current* code (re-read 2026-07-26, after
`a21cf90` added `claude-opus-5` / `claude-fable-5` to the registry) and against the design
doc. No NEEDS CLARIFICATION markers survived the spec phase; the product-level questions are
already answered as RATIFIED-BY-DEFAULT in `clarifications-needed.md` (decisions 1–8). What
follows are the *plan-level* choices, four of which are new and recorded as RBD-9..RBD-12.

---

## R1 — Where the override slots into resolution

**Decision**: Add a pure helper `resolveUserChatModelKey(overrideKey, sharedDefaultKey)` to
`server/api/chat-models.js` and call it from `resolveChatModel`'s **non-BYOK branch only**.
`resolveChatModel` gains one optional parameter, `userOverrideKey`. Nothing else in the
function changes.

```js
function resolveUserChatModelKey(overrideKey, sharedDefaultKey) {
  if (overrideKey) {
    if (isSharedEligible(overrideKey)) return overrideKey;
    console.warn(/* ineligible override → falling back to the shared default */);
  }
  return resolveSharedDefaultKey(sharedDefaultKey);
}
```

**Rationale**:

- The BYOK branch returns (or errors) *before* the shared-key branch is reached, so
  "BYOK wins" and "`byok_misconfigured` never falls back" (FR-003) hold **structurally** —
  they are properties of code the diff does not touch, not of a rule the diff has to
  remember. This is the cheapest possible way to be right about the invariant that matters
  most.
- The helper mirrors `resolveSharedDefaultKey` exactly — same shape, same
  eligibility-guard-then-fall-through pattern, same warning style — so the precedence chain
  reads top-to-bottom in one file, matching the design doc's sentence one-for-one.
- It is independently unit-testable without instantiating a provider client (the
  precedence tests never touch a network path).

**Alternatives considered**:

- *Inline the check in `resolveChatModel`* — two extra lines, no new export, but the
  fallback rule becomes untestable without going through model instantiation, and the
  admin endpoint would have to duplicate the same logic to show an effective key.
- *A resolution "chain"/strategy abstraction* — rejected outright: YAGNI (Principle III),
  and it would be a refactor of `resolveChatModel`, which the assignment forbids.
- *Resolve the override in `chat.js`* — rejected: it would put one link of the precedence
  chain outside the module that owns the other four, which is exactly the drift the design
  doc's single-sentence chain exists to prevent.

**Recorded as**: RBD-9 (helper placement + one-parameter extension).

---

## R2 — No database-side constraint on the stored key

**Decision**: `users.chat_model_override text` — nullable, no default, **no CHECK constraint,
no enum, no FK**. Validation lives in the API (write time) and in `isSharedEligible`
(resolution time).

**Rationale**: the set of legal values is a *code-side* registry (`MODEL_DEFS`) that changes
with every release — today's registry-update agent added two entries mid-flight. A DB-level
constraint would demand a migration per model addition and would fight the feature's own
central rule: eligibility is **derived** (`hasServerKey(provider)`) and *deployment-dependent*
— the same key is eligible in prod and ineligible in a dev pod without that provider's key.
A constraint cannot express that, and a stale one would reject a legitimate pin. Compare
`signup_source` (1799300000000), which *does* carry a CHECK — correctly, because its two
values are a closed, code-independent vocabulary.

**Alternatives considered**: CHECK against a hardcoded key list (rejected: migration per
model, and wrong across deployments); FK to a `models` table (rejected: there is no such
table and inventing one to satisfy a nullable text column is exactly the ceremony Principle
III forbids).

---

## R3 — The per-turn read: ride `loadByokSettings`

**Decision**: add `chat_model_override` to the column list in
`server/api/byok-settings.js:loadByokSettings` (~line 155), and read it in `chat.js` from the
row that call already returns.

**Rationale**: `chat.js` (~line 793) already executes
`SELECT byok_enabled, byok_model_key, <provider key columns> FROM users WHERE id = $1` on
**every** turn. Adding one column to that list costs nothing measurable and gives FR-012
(next-turn effect, no re-login, no restart) for free — no cache to invalidate, no
multi-replica staleness (the failure mode 021 MEDIUM-2 and the shared-default rollout both
had to solve). A cache would be strictly worse *and* more code.

The cost is an altitude smell: a function named `loadByokSettings` now returns a non-BYOK
column. Accepted deliberately, with (a) a comment at the SELECT naming it as the per-turn
user-settings row, and (b) a test proving the client-facing `buildResponse` — which builds an
explicit key set — cannot leak it. Renaming the function to something like
`loadChatTurnUserSettings` would touch every caller and its test suites: a refactor the
assignment's "keep the diff tight" rules out. Flagged as a MEDIUM for the implement brief,
not a blocker.

**Alternatives considered**: a second `SELECT chat_model_override FROM users` in `chat.js`
(rejected: an extra round trip per turn to avoid a naming smell); joining the override into
`app_settings`' cached snapshot (rejected: it is per-user data and would reintroduce cache
staleness); reading it from the JWT (rejected outright — it would require re-login to take
effect, violating FR-012, and would put admin-only data in a token the user can decode).

**Recorded as**: RBD-10 (ride the existing per-turn read).

---

## R4 — Admin endpoint shape

**Decision**: `PATCH /api/admin/users/:userId/chat-model`, body `{ modelKey: string | null }`,
returning `{ chatModelOverride, effectiveModelKey }`. The eligible-model *list* is **not** a
new endpoint — the admin page already fetches `GET /api/admin/settings/shared-model`
(`models` + `providers`) on mount, and the picker reuses that payload (RBD-3). The stored
per-user value rides the existing `GET /api/admin/users` row as `chatModelOverride`.

**Rationale**:

- `PATCH /users/:userId/<thing>` with a single-field body is the established shape in
  `admin.js` (`/credit`, `/email-enabled`), so the handler, its validation shape, its 404,
  and its error copy all mirror code that already exists.
- Write-time validation reuses the shared-default PUT's two-branch check verbatim —
  unknown key → `400 Unknown model: X`; known key whose provider has no shared server key →
  `400 Model "X" has no shared server key…` — which is precisely `isSharedEligible`
  decomposed into two messages. A test asserts the endpoint's accept/reject decision agrees
  with `isSharedEligible` across **every** registry entry, so the two can never drift even
  though the messages are spelled out separately.
- Returning `effectiveModelKey` (computed with the same `resolveUserChatModelKey`) makes the
  endpoint self-describing and gives the UI a reconciliation value after the "last write
  wins" concurrent-edit case in the spec's Edge Cases.
- **No** per-user `effectiveModelKey` on the `GET /users` list payload: the client can
  derive it from the stored key plus the shared-model payload it already holds (stored key
  present in `models` → that label; otherwise → `sharedModel.effectiveModelKey`), which is
  the *same* derivation the shared-default picker already performs. Adding a server-computed
  field per row would mean N calls to the resolver on every admin page load for information
  the client can compute exactly.

**Alternatives considered**: `PUT /users/:userId/chat-model` (rejected: PATCH matches the
neighbouring per-user handlers and the semantics are a partial update); a dedicated
`GET /users/:userId/chat-model` returning stored + eligible list (rejected: a second source
of the eligible list is precisely the drift RBD-3 forbids, and it would add a fetch per
expanded row); folding the override into the existing `PATCH /credit` handler (rejected:
unrelated concerns, and it would make a model change require sending a credit value).

**Recorded as**: RBD-11 (endpoint shape) and RBD-12 (no per-row `effectiveModelKey`).

---

## R5 — Displaying a stale override in the admin UI

**Decision**: reuse the shared-default picker's exact pattern (`AdminPage.jsx` ~lines
300–305): when the stored key is not present in the eligible `models` list, render an extra
**disabled** option `"<key> (unavailable — using <effective label>)"` as the selected value.
The "no override" option is the empty-string value labelled `Default (<shared effective
label>)`.

**Rationale**: FR-010 requires the admin to see *both* the stored intent and the effective
outcome; showing "Default" would be a lie, and hiding the value would make it uneditable
(the select could not display its own current state). The pattern already exists, is already
styled, and is already understood by the one person who uses this page. Zero new UI
vocabulary.

**Alternatives considered**: a warning badge next to the picker (rejected: more markup for
the same information); auto-clearing the stale value so the display is honest by
construction (rejected — that is RBD-2, and it destroys admin intent on what is often a
temporary deployment condition).

---

## R6 — Proving non-disclosure (FR-011/SC-005) rather than asserting it

**Decision**: two structural facts plus one test:

1. `buildResponse` in `byok-settings.js` constructs an **explicit** object literal
   (`enabled`, `providers`, `modelKey`, `models`, plus per-provider `hasKey`) — it never
   spreads the row — so the new column cannot ride out through the one endpoint that reads
   the same row the chat path reads. A test pins the response's key set (the same technique
   034 used on `/auth/me`).
2. Nothing else reads `chat_model_override`: the only other consumers are `chat.js`
   (server-internal) and `admin.js` (behind `requireAdmin`). The chat stream carries model
   *behavior*, never the model key, so the affected user sees no change of any kind.

**Rationale**: "no surface discloses it" is an unbounded negative claim; the only honest way
to hold it is to make the *shape* of the one at-risk payload explicit and pin it with a test
that fails if someone later switches `buildResponse` to a spread.

**Alternatives considered**: an allow-list sanitizer on the users row (rejected: new
machinery for a payload that is already explicit); relying on code review (there is none —
Principle II is unambiguous that the suite is the reviewer).

---

## Verified code facts this plan depends on

Re-read 2026-07-26; line numbers are indicative only — the implement agent MUST re-read
(`chat-models.js` is being edited concurrently by a registry-update agent).

| Fact | Location |
|---|---|
| `isSharedEligible(key)` = registry entry + `hasServerKey(provider)` | `server/api/chat-models.js` ~317 (not exported yet) |
| `resolveSharedDefaultKey(storedKey)` — stored → env → `DEFAULT_MODEL_KEY`, each eligibility-guarded with a warn | `server/api/chat-models.js` ~348 |
| `resolveChatModel({ isByok, byokSettings, decryptKey, sharedDefaultKey })`; BYOK branch returns/errors before the shared branch | `server/api/chat-models.js` ~388 |
| **Single** runtime call site | `server/api/chat.js` ~860 (`sharedDefaultKey: appSettings.getSharedDefaultModel()`) |
| Per-turn users-row read | `server/api/byok-settings.js` ~155 (`loadByokSettings`), called at `chat.js` ~793 |
| Client-facing BYOK payload is an explicit literal | `server/api/byok-settings.js` ~39 (`buildResponse`) |
| Eligible-list payload + write-time validation to mirror | `server/api/admin.js` 25–95 (`sharedDefaultModels`, `sharedDefaultProviders`, `PUT /settings/shared-model`) |
| Per-user PATCH precedent (validate → UPDATE … RETURNING → 404 on no rows) | `server/api/admin.js` 205–257 |
| Admin router is mounted **behind** `requireAdmin` | `server/index.js:511` — `app.use('/api/admin', requireAdmin, admin.router)` |
| Real-gate 403 test exemplar (034) | `server/__tests__/admin-auth-capture.test.js` 58–63, 155–172 |
| Chat-route mock harness (drives `POST /api/chat` with `resolveChatModel` mocked) | `server/__tests__/chat-reservation-release.test.js` 12–80 |
| Shared-default picker + stale-option markup to mirror | `client/src/pages/AdminPage.jsx` 58–75, 121–123, 280–312 |
| Expanded detail row (where the picker goes) | `client/src/pages/AdminPage.jsx` 462–495 |
| Latest migration timestamp | `migrations/1799400000000_add-auth-ip-capture.js` |
| Auxiliary models are hardcoded, never consult a user row | `server/api/chat-models.js` `getCompactionModel` ~281, `getContextualizerModel` ~290, `getThinkingSummaryModels` ~299 |
