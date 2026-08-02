# Clarifications — 040-restore-undo-attribution

No blocking questions. Sam's core decision (record human UI restores under the
chat-assistant identity, both tables) was made in advance and is specified as
given, not defaulted. The following secondary decisions were taken by default
under the parallel-pipeline no-interaction rule.

All entries: **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01)** — except:

- **D2**, RESOLVED by an explicit coordinator correction (2026-08-01), kept as the
  record of that correction;
- **D13**, **Sam's explicit decision** on the plan-stage F1 finding (2026-08-01) —
  not a default. It re-scopes US1/SC-001 to the endpoint contract, adds the
  offer-honesty guard (FR-016/FR-017/FR-018, US6), and files the document-level
  undo affordance as follow-on work. **D7 is superseded by it**; D14–D16 are the
  defaults taken while implementing D13.

---

## D1 — Legacy dead `''` edit records: leave in place, no backfill

**Question**: Production already contains `agent_edits` rows with `agent_name = ''`
(every human UI restore since 023) and their paired `yjs_updates` rows with
`agent_name = NULL`. Should these be backfilled/re-attributed to the assistant
identity so old restores become undoable retroactively?

**Why it came up**: FR-001 fixes new restores only; the old rows stay dead.

**Rationale for the default (no backfill)**: This feature has no migration slot
(038 owns the only one) and a data backfill without a migration is exactly the
kind of side-channel schema-adjacent write the collision contract forbids. The
rows are harmless — unreachable by every undo surface, invisible in history
attribution — and retroactively re-attributing an old restore to the assistant
identity would silently change historical attribution, which deserves its own
explicit decision if ever wanted. Spec encodes: leave rows untouched (FR-007,
Assumptions).

---

## D2 — F7 citation path: `server/mcp/yjs/edit-range.js:185` (RESOLVED by coordinator, 2026-08-01)

**Status**: No longer a defaulted decision — the coordinator answered.

**History**: The original brief cited `server/undo/edit-range.js:184-186`,
which does not exist; this spec initially defaulted the F7 comment to
`server/undo/inverse.js:79-80` (the normalized identity comparison). The
coordinator then corrected the path: the audit actually cited
`server/mcp/yjs/edit-range.js`, whose identity filter at line 185 is real
(`r.userId === identity.userId && r.agentName === identity.agentName`).

**Resolution**: The F7 display-name-equality documentation comment lands at
`server/mcp/yjs/edit-range.js:185` (FR-011). The sibling comparisons at
`server/undo/inverse.js:80` and `server/undo/legacy.js:46` are consolidated
with it through the shared identity predicate (FR-015). The collision contract
lists all three files.

**Follow-on finding from the correction (coordinator-verified)**: the
`edit-range.js` comparison is RAW `===` while the other two normalize with
`?? null` — the three implementations of "same identity" disagree whenever one
side is `null` (DB) and the other `undefined` (in-process object). Same
NULL-vs-sentinel confusion class as F2, so pulled into 040's scope as FR-015:
one shared exported predicate used by all three sites (behavior-preserving for
the normalized two, a bug fix for `edit-range.js`), a test asserting agreement
on the `null`-vs-`undefined` case, and a reviewer grep for any fourth escaped
comparison (SC-009).

---

## D3 — Where the FK-divergence rationale comment lives

**Question**: The FK-policy divergence rationale (`yjs_updates.user_id` ON
DELETE SET NULL vs `agent_edits.user_id` ON DELETE CASCADE) must be captured
"as a comment" — in which file?

**Why it came up**: The natural candidates are the two migration files, but
migrations are immutable applied history and 038 owns the migration surface.

**Rationale for the default**: Land it in `server/undo/edit-records.js`'s
module documentation (FR-012), alongside the sentinel rule (FR-007) — the one
place a developer working on undo identity semantics will read, and a file this
feature already owns. Migration files stay untouched.

---

## D4 — "Unknown author" presentation specifics

**Question**: Exact label, key, and color for the synthetic unattributed-author
entry (F6).

**Why it came up**: The audit prescribes "a synthetic 'Unknown author' entry
(stable key, stable color)" but not the literals.

**Rationale for the default**: Label "Unknown author", a fixed synthetic key
(e.g. `unknown`) so React keys and dedupe are stable, color `#888888` matching
both the server's no-id fallback and the F14 client fallback — one neutral
gray for "no identity" everywhere in history. Null `id`, no email/picture,
`isAgent: false`. One collapsed entry per version regardless of how many
unattributed rows it contains (avoids contributor-list spam from long-dead
accounts).

---

## D5 — Restore participates in redo

**Question**: Should an undone human UI restore be redo-able, and should the
spec require it?

**Why it came up**: The audit and Sam's decision speak to Undo; redo is implied
by "recording under the chat-assistant identity" but was not stated.

**Rationale for the default**: Yes (FR-002, US1 scenario 3). The log-derived
machinery gives redo for free once the record is reachable — the edit record
enters the standard active/undone state machine — and excluding restores from
redo would require special-casing that contradicts 016's uniform model.

---

## D6 — recordEdit guard stays non-fatal to the enclosing operation

**Question**: When the loud guard rejects (null agent name), should the
enclosing restore/modify fail too, or keep 023's non-fatal parity?

**Why it came up**: "Loud, explicit rejection" could be read as making the
whole operation fail.

**Rationale for the default**: Keep non-fatal parity (FR-006, US4 scenario 2):
023 deliberately ratified that a recording failure must not lose the user's
restore/modify — the content change is the primary product action, undoability
is secondary. The defect being closed is the *silence*, not the non-fatality.
After FR-001/FR-005 no live code path can pass a null identity anyway; the
guard is a tripwire for future callers.

---

## D7 — ~~No chat-surface copy or UI changes for restore-undo~~ — **SUPERSEDED 2026-08-01 by D13**

> **This decision was made on a premise that is verifiably false and has been re-decided.**
> Its rationale below claims *"the existing control is generic ('undo the assistant identity's
> last edit')"*. Verified against `main`: the control is **not** generic — `UndoEditButton`
> renders only inside a chat `modify` tool card and only for `part === lastModifyPart`
> (`client/src/components/AiChatMessages.jsx:541-547`, `:658`). The conclusion changes with the
> premise: 040 now DOES make a client change (the offer-honesty guard, FR-017). See **D13**.
> The original text is kept below as the record of what was decided and why it failed.

### Original decision (superseded)

## D7 (original) — No chat-surface copy or UI changes for restore-undo

**Question**: Should the chat/undo UI label the pending undo as "undo restore"
or otherwise distinguish restores from assistant edits?

**Why it came up**: After FR-001 the Undo button will invert restores too;
a user might expect the control to say what it will undo.

**Rationale for the default**: Out of scope — no UI copy changes (Assumptions,
US1). The existing control is generic ("undo the assistant identity's last
edit") and the restore is now honestly one of those edits; per-target labeling
is a product/UX decision that touches the chat surface beyond the ratified
"constant extraction only" boundary for `server/api/chat.js` and its client.
The attribution in version history (FR-003) already tells the user what
happened.

---

## D8 — The shared module is `server/agent-identity.js`, and it holds the predicate too

**Question**: The Collision Contract calls for "one NEW shared module for the chat-assistant
identity constant" and names `server/undo/edit-records.js` as the "natural home" for the
FR-015 identity-comparison predicate. Where does each actually land?

**Why it came up**: Verified on current `main`, `server/mcp/yjs/edit-range.js` requires **only
`yjs`** — it is a pure leaf. Putting the predicate in `edit-records.js` would force that leaf
to depend on the `agent_edits` DB-access layer just to obtain a pure comparison function.

**Rationale for the default**: one new module, `server/agent-identity.js`, exports BOTH
`CHAT_AGENT_NAME` and `isSameIdentity`. It has **zero `require`s**, which turns FR-005's
"must not create a circular dependency with the chat surface" into a structural property
instead of a review promise, and it keeps the transport-level durability poll from depending
on persistence. `server/undo/edit-records.js` still receives the FR-007 sentinel rule and the
FR-012 FK-divergence rationale — identity *semantics* documentation stays where a developer
looks for it. The spec's "natural home" phrasing is advisory; FR-015 only requires that exactly
one exported predicate exist. See research.md R1 and contracts/agent-identity.md.

---

## D9 — FR-010 / US5 (stable history badge color) is already delivered by feature 039

**Question**: F14 prescribes replacing the date-salted presence-palette fallback in the version
panel with the stable neutral `#888888`. Is that still outstanding?

**Why it came up**: The spec cites `client/src/components/HierarchicalVersionList.jsx:56` and
its `colorUtils.js` import. On current `main` (post-039) that file **does not import
`colorUtils` at all**; line 61 already reads `backgroundColor: author.color || '#888888'` with
a comment citing "Feature 039 FR-018", and `HierarchicalVersionList.test.jsx:487` already
asserts it on any date. 039's FR-018 is verbatim 040's FR-010.

**Rationale for the default**: do not re-implement a shipped fix. US5 becomes a
**verification-only** phase — confirm the code and the passing test by inspection, confirm
`client/src/utils/colorUtils.js` still carries the deliberate daily presence rotation
untouched, and record the overlap. FR-010 and the color half of SC-005 are satisfied without a
code change. The spec's `:56` citation is recorded as stale.

---

## D10 — Unknown-author synthesis site, and consolidating the fourth constant definition

**Question (a)**: Where is the synthetic "Unknown author" entry produced — inside `createAuthor`,
or at the call sites?

**Rationale for the default**: at the call sites. `createAuthor`'s `if (!userId) return null`
contract is preserved, because `mergeNamedVersions` also calls it for
`createdBy: createAuthor(nv)`; changing the helper would silently turn a named version with no
creator from `createdBy: null` into an unknown-author object, altering an unrelated client
contract. The synthesis is an explicit `UNKNOWN_AUTHOR` constant applied in
`groupUpdatesIntoVersions` (which the sub-version drill-down **reuses**, so one site covers both
paths FR-008 requires) and at the single-author metadata site `version-history.js:794`.

**Question (b)**: FR-005 requires "exactly one authoritative definition" of the assistant name.
A grep finds a **fourth** server-side definition the spec does not mention:
`server/onboarding.js:18` (`const AGENT_NAME = 'Squire Docs Assistant'`, welcome-doc
attribution, commented "mirrors the chat assistant author").

**Rationale for the default**: `server/onboarding.js` consumes the shared constant and drops its
literal — a second server-side copy whose stated purpose is to mirror the first is exactly the
drift FR-005 exists to prevent, and it genuinely is the same identity. The two **client**
strings (`AiPanel.jsx:35-36`, `SettingsPage.jsx:173`) are NOT consolidated: display copy in an
ESM bundle that must not import a CommonJS server module, and neither participates in undo
identity.

---

## D11 — The SC-009 grep found two more raw comparisons: convert them, don't file them

**Question**: SC-009 requires the reviewer to grep for a fourth inline `(userId, agentName)`
comparison and "confirm none remains or file it explicitly". The grep finds three more beyond
the spec's named sites: `server/mcp/tools/modify.js:308` and `:327` (foreign-edit conflict
guard and its `isSelf` replay filter) and `server/api/chat-staleness.js:111` (`isOwnAgent`).
Convert or file?

**Rationale for the default**: convert all three to `isSameIdentity`. They are **provably
behavior-identical** under the normalized predicate — in each, the right-hand identity is an
agent token or the chat identity, whose `agentName` is always a real non-empty string, so the
`undefined`-vs-`null` divergence the predicate fixes cannot arise there. The conversion is
therefore free, and leaving two known raw comparisons in place would fail SC-009's grep by
construction and force it to be re-litigated at review time. FR-015's stated goal — "'is this
row mine?' has exactly one definition" — is only met if the grep comes back clean.
`server/origin.js:182` (`origin.agentName ?? null`) is **normalization, not comparison**, and
stays as it is. Parameterized SQL identity predicates in `edit-records.js` are Postgres-side
equality on a `NOT NULL` column and are not replaced.

*(Note: 038 and 039 are merged, so `modify.js` and `chat-staleness.js` are no longer
collision-restricted; the Collision Contract's file list is a floor, not a ceiling, now that
the tree is clear. No migration is added, and none of the explicitly forbidden files —
`origin.js`, `document-service.js`, `postgres-persistence.js`, the diff subsystem, the
websocket layer — is touched.)*

---

## D12 — The loud guard rejects `''` too, and stops at `recordEdit`

**Question (a)**: FR-006 says reject "a missing or null agent name". Does the guard also reject
the empty string?

**Rationale for the default**: yes — `null`, `undefined`, non-string, and empty/whitespace-only
all reject. FR-007 retires `''` for all new records; a guard that let `''` through would leave
the exact defect being closed (a dead, unreachable `''` row) reachable by a future caller.

**Question (b)**: `insertLegacyUndone` (`edit-records.js:167`) writes the same `NOT NULL`
column. Does the guard extend to it?

**Rationale for the default**: no. It runs **inside** the `finalizeClaim` transaction, so a
throw would roll back a legitimate legacy undo — trading a silent failure for a louder and
strictly worse one. Its identity comes from the undo-service call chain, which is already
`(userId, agentName)` from an authenticated surface. The sentinel-rule comment states this
explicitly so a future reader does not "finish the job" unsafely. Recorded rather than left
implicit because it is a deliberate asymmetry.

---

## Accepted consequences (no decision required, flagged for review)

Attributing a web-UI restore's `yjs_updates` row to `CHAT_AGENT_NAME` is visible to two
consumers beyond version history. Both were enumerated and assessed (research R8); neither
gets a code change, and both are listed so a reviewer meets them as analysed consequences:

- `server/api/chat-staleness.js` `foreignEditsSince` — a user's own UI restore is no longer
  reported to the assistant as a *foreign* edit. Coherent with the ratified attribution: the
  restore now genuinely is the assistant acting for that user.
- `server/mcp/tools/modify.js` conflict guard — for the **chat assistant's own** modify (same
  `userId` + `CHAT_AGENT_NAME`) a preceding human UI restore is now `isSelf` rather than
  foreign, so it is replayed into the expected document instead of triggering the divergence
  check. **MCP agent tokens are unaffected** — a different `agentName` still sees the restore
  as foreign, so the cross-agent guardrail is intact.

---

## D13 — F1 resolution: API-level fix plus a client honesty guard (**Sam's explicit decision, 2026-08-01 — not a default**)

**Status**: RESOLVED BY SAM. Supersedes D7. Recorded here because it changes the shape of the
feature, not merely a detail of it.

**Question**: The plan-stage analysis found (HIGH) that no client control can reach a restore's
undo — `UndoEditButton` renders only inside a chat `modify` tool card, and only for the latest
one, so a version-history restore (which creates no chat card) has no affordance at all. Worse:
because `POST /api/docs/:docId/undo` selects the identity's most-recent record (LIFO) and uses
the request's `toolCallId` **only** to stamp the `reverted` flag, once restores enter the queue
pressing "Undo edit" on the assistant's card would invert the **restore** and mark the
**modify** "Reverted" — a false statement to the user. Ship US1 as written (needs a new UI
surface), ship API-only (leaves the lie on screen), or something else?

**Sam's decision — option (c), three parts**:

1. **Re-scope US1/SC-001 to the endpoint contract.** 040 delivers "a human UI restore is
   genuinely undoable" at the API level. The story no longer claims a user can click something
   to undo a restore, because after this feature they still cannot.
2. **Add the offer-honesty guard** (FR-016/FR-017/FR-018, US6): `/undo-status` additively
   reports each direction's target record identity, and the chat card offers its control only
   when that target is its own edit. This keeps a lie off the screen.
3. **File the document-level undo affordance as follow-on work** — `promotion-notes.md`
   OWED-1, with the full F1 analysis, what building it needs, and why it was deferred. Noted in
   the spec's Out of Scope.

**Why this is the right cut**: the mechanism must exist before any affordance can (an affordance
with no invertible record behind it is not buildable), and the *immediate harm* is not the
missing button — it is the button that would misreport what it did. Option (c) closes the harm
now and leaves the capability gap as an honest, filed absence.

---

## D14 — The guard keys on `edit_clock_start`, not on the undo/redo target range

**Question**: FR-016 must give the client something to match a chat `modify` card against. Which
value identifies "the record the endpoint would act on"?

**Why it came up**: an `agent_edits` row carries several clock fields, and most of them move.
`finalizeClaim` **rewrites** `undo_target_*`/`redo_target_*` on every transition (the next step's
input is the inverse's own clock), so a client that matched on those would match before an undo
and stop matching after a redo — the control would vanish on a perfectly valid record.

**Rationale for the default**: report the record's **`edit_clock_start`**, which is immutable —
it is part of the row's unique key `(doc_guid, user_id, agent_name, edit_clock_start)` and is
never rewritten. It equals the value `modify` already returns to the client as
`editRange.clockStart` (`server/mcp/tools/modify.js:574`), so the client-side comparison is
`nextUndo.editClockStart === part.output.editRange.clockStart` with no new plumbing, and it is
stable across the whole undo↔redo cycle (US6 scenario 4). A restore's record carries
`edit_clock_start = newClock`, which can never collide with a modify's range.

**Shape**: additive fields on the existing `{canUndo, canRedo}` response — e.g.
`nextUndo: { editClockStart }` / `nextRedo: { editClockStart }` — **absent** (never `null`-guessed)
when no `agent_edits` row backs the answer, which is exactly the legacy-derivation fallback in
`getUndoStatus` (`server/undo/undo-service.js:326-336`). No schema change and no new query: both
rows are already fetched by `nextUndoTarget`/`nextRedoTarget`.

---

## D15 — The guard is fail-open, and hides rather than disables

**Question (a)**: What happens when the client cannot make the comparison — an older/legacy
undo-status response without the new field, or a `modify` whose durability wait timed out so its
output carries `editRangePending` and no `editRange`?

**Rationale for the default**: **fail open** — offer the control, exactly as today (FR-017,
US6 scenario 5). A fail-closed guard would silently remove a working Undo button from every
pre-existing chat card whenever the field was missing, converting an honesty fix into a
capability regression. The failure mode of fail-open is the status quo ante, which is
acceptable; the failure mode of fail-closed is a new, silent loss of function.

**Question (b)**: When the comparison *does* run and does not match, hide the control or disable
it with a reason?

**Rationale for the default**: **hide it**, matching the component's existing idiom — it already
returns `null` when there is nothing to show, and `showButton` already gates on availability, so
hiding is a one-condition change with no new copy. FR-017 permits a short honest reason instead,
but adding user-facing wording is a product/UX call that the (revised) D7 boundary still reserves;
the "Reverted" label on an already-undone card is unaffected and still renders. If Sam later
wants an explanatory string, it is an additive change to the same condition.

---

## D16 — What survives of the original D7

**Question**: D7 forbade "chat-surface copy or UI changes". Now that 040 makes a client change,
where is the new boundary?

**Rationale for the default**: the boundary moves from "no client change" to **"no new
user-facing wording, and no new surface"**. Permitted: the structural offer guard in
`UndoEditButton` (FR-017) and the additive `/undo-status` fields (FR-016). Still excluded:
per-target labels such as "Undo restore", any new control anywhere in the document or version
panel (that is `promotion-notes.md` OWED-1), and any change to what the undo/redo **endpoints**
select — target selection stays identity-LIFO, and FR-017 governs only what a client *offers*.
The original D7's sound half stands: version-history attribution (FR-003) is what tells the user
a restore happened, and this feature adds no copy to say it twice.

---

## D17 — The server enforces FR-018 itself; the client guard is not the only thing standing between the user and the lie (**decided by the orchestrator, 2026-08-02 — an explicit call after N1 was reported, NOT ratified-by-default**)

**Status**: DECIDED BY THE ORCHESTRATOR. The analyze stage surfaced N1 and deliberately did not
decide it; the orchestrator adopted it before implementation began. Recorded here as an explicit
decision rather than a default because it adds a requirement (FR-019) that the gate did not carry.

**Why it came up (N1)**: FR-018 says no surface may label an edit "Reverted" unless that edit is
what was inverted. But the guard D13 planned is **client-side only**, and it is fed by
`UndoEditButton`'s **30-second poll** (`AiChatMessages.jsx:628`). Nothing tells the chat component
that a restore just happened in the version-history panel — the two surfaces do not communicate.
So for up to 30 seconds after a restore the modify card still shows its Undo button with stale
`canUndo`/`nextUndo` data; clicking it inverts the **restore** while stamping "Reverted" on the
**modify** — precisely the lie FR-018 exists to prevent, merely time-boxed. Sam chose option (c)
in D13 specifically so that **no user-visible lie ships**; a 30-second window in which the lie is
fully reachable does not satisfy that. N3 is the same hole reached deliberately (a click on a
status fetched before the restore), and N2's residual window is a second route into it (a
`modify` whose durability wait timed out has no `editRange`, so the client guard fails open by
design and does not even attempt to check).

**Decision**: add **FR-019** — the server enforces it. In `makeUndoRedoHandler`
(`server/index.js`), stamp the chat part's `reverted` flag **only** when the supplied
`toolCallId` names the record that was actually inverted.

**Why this is cheap and correct**: no new plumbing is required, only a comparison. The handler
**already** loads the chat to set the flag (`setChatPartReverted`); `performUndo`/`performRedo`
already resolve the acted-on record internally; and the part **already** carries
`editRange.clockStart`, which is by construction the same number as that record's
`agent_edits.edit_clock_start` (`modify.js:574` writes one from the other). The only additions
are: the undo service reporting which record it acted on, and one equality check before the write.

**What it explicitly does NOT change**: the endpoint contract. `/undo` still inverts the
identity's next target by identity-LIFO, exactly as FR-002 and D16 require. On a mismatch the
undo **still happens** — only the mislabel is withheld. The guard changes what is *recorded about*
the action, never the action.

**Fail direction, stated deliberately** (this is the part a reviewer should check):

- **Fail closed** when the part has no `editRange.clockStart` (the `editRangePending` case, N2):
  the acted record is known, but the part is unidentifiable, so any stamp would be a guess. Not
  stamping costs a missing "Reverted" marker on an already-rare card; stamping risks the lie.
- **Fail open** when no record backs the action at all — the legacy-derivation undo path. This
  is safe *by construction*, not by optimism: that path runs **only** when the identity has no
  `agent_edits` rows whatsoever in the document (`undo-service.js` checks `latestEdit` first), so
  there is no competing record — and in particular no restore — that the flag could be
  misattributed away from. Refusing here would regress a working pre-016 path for no honesty gain.

**Consequence for D13/D15**: FR-017's client guard is demoted from *sole enforcement* to a **UX
nicety** — it stops the user from being offered a button that would do something other than what
it says, which is still worth having. But FR-018 no longer depends on it, so D15's mandatory
fail-open (which would otherwise be a hole) is now unambiguously the right call: the client may
fail open freely, because the server refuses to mislabel regardless.

---

## D18 — FR-010 was NOT already delivered by 039; Phase 7 is a real code change (**RATIFIED-BY-DEFAULT — Sam pre-authorized, 2026-08-01**)

**Question**: T029/T030 and research R3/D9 assert that FR-010 (the stable neutral history badge
colour) already shipped in feature 039 as its FR-018, making Phase 7 verification-only with zero
diff. Implementation found that premise is **false**. What should ship?

**What was actually found** (all verifiable by inspection at the stated paths):

1. `client/src/components/HierarchicalVersionList.jsx:3` **did** import
   `generateColorFromId` from `../utils/colorUtils` — the task text asserts it "does not import
   `colorUtils`".
2. Line 56 rendered `backgroundColor: author.color || generateColorFromId(author.id)` — not the
   `author.color || '#888888'` the task text quotes.
3. `generateColorFromId` **is** the date-salted presence function: it builds its hash key as
   `id + new Date().toISOString().slice(0, 10)`, so a colourless author's history badge changed
   colour **every day** — exactly the defect FR-010 describes.
4. The test T030 says to run — "renders the stable neutral #888888 for a colourless author, on
   any date" at `HierarchicalVersionList.test.jsx:487` — **did not exist**. The file was 465
   lines long.
5. Feature 039's `spec.md:198` does state this requirement as its FR-018, so the requirement was
   *written* there. It was never *implemented*.

Note the near-miss that probably caused the stale reading: `generateColorFromId` returns
`'#888888'` when `!id`, so an author with `id: null` (the new "Unknown author") did already get
the neutral. The bug only bit authors that **have** an id but no colour — which is why a casual
check of the unknown-author case would have looked correct.

**Decision (best default)**: implement it. The one-line fallback change plus removing the now-
unused `colorUtils` import, and the missing test written for real (asserting the same colour on
two different mocked dates). `colorUtils.js` itself is **untouched** — FR-010's second half
requires the presence/cursor daily rotation to survive, and it does.

**Rationale**: FR-010 is an accepted requirement of this feature with a success criterion
(SC-005's "the entry's colour is identical across days"). Shipping 040 with it unmet because a
task comment said someone else had done it would leave a requirement silently unsatisfied in two
consecutive features. The change is one line of behaviour in a display path, fully covered by a
new test, and touches no undo/attribution logic. Removing the import is what makes the fix
structural rather than a value someone re-derives later.

**For the merge queue**: 039's FR-018 can be considered discharged by 040. If 039 has an open
verification item for it, close it against this commit.
