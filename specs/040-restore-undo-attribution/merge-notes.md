# Merge notes — 040-restore-undo-attribution

> **⚠️ SUPERSEDED IN PART (Sam, 2026-08-02) — US1 and US6 were CUT after merge.**
> Restore-undo and its offer/label guard have been removed from the product. Anything below that
> describes a web-UI restore as recorded, undoable, or attributed to the chat assistant — and
> anything about `server/undo/reverted-flag.js`, the `/undo-status` `nextUndo`/`nextRedo` fields,
> `actedEditClockStart`, or the client offer guard — describes code that no longer exists. This
> file is kept as the record of what was built. See `spec.md` ("Post-merge cut") and D19 in
> `clarifications-needed.md` for the reasoning.


Handoff for the merge queue. Everything here is either **owed** (an action the queue must take)
or **analysed** (something a reviewer will notice and should meet as a decision, not a surprise).

---

## 1. README deliverable — OWED, apply verbatim (FR-013, finding F6)

**The implementation agent did not and must not edit `README.md`.** Two passages need replacing.

### 1a. `README.md:467` — the restore paragraph

That paragraph was corrected by an earlier merge queue to describe *today's broken behaviour* and
to point forward at this spec. 040 makes it stale again. Current text ends:

> …A restore from the web UI is currently recorded without an actor identity, so no undo surface
> can invert it; unifying the two paths is spec 040 (`specs/040-restore-undo-attribution/`).

**Replacement for the whole paragraph:**

> Restore is **non-destructive**: restoring a previous version creates a new version with that
> content rather than discarding subsequent history. All users see the restored content in
> real-time (delivered cross-instance, never silently skipped). Both restore surfaces now record
> the restore as a tracked edit under an acting identity, in the update log and the edit record
> alike. A restore over MCP (`restore_document_version`) is attributed to the acting agent and
> can be inverted by that agent's `undo`. A restore from the web UI is attributed to the
> assistant identity acting for the requesting user — it appears in version history as e.g.
> "Squire Docs Assistant (Sam Goldstein)" — and is invertible, and redoable, **through the
> `/api/docs/:id/undo` and `/redo` endpoints**. Note that there is not yet a control in the
> document or version panel that performs it: undo of a restore is available via the API, and a
> document-level affordance is not yet built.

Constraints this wording satisfies, deliberately:

- It does **not** claim a user can click something to undo a restore. They still cannot (D13).
  `promotion-notes.md` OWED-1 tracks that affordance.
- It drops the "spec 040" forward reference.
- It names the attribution change explicitly, because it is user-visible (FR-003).

### 1b. `README.md:583` — the Undo button sentence (finding F6)

Inside the "**Undo agent edits**" bullet, this sentence is now incomplete:

> The most recent `modify` diff has an Undo button that reverts the edit via the
> `/api/docs/:id/undo` and `/redo` endpoints.

**Replacement sentence:**

> The most recent `modify` diff has an Undo button that reverts the edit via the
> `/api/docs/:id/undo` and `/redo` endpoints. The button appears only when that edit is genuinely
> the identity's next undo target — if a later edit or a version restore is what `/undo` would
> actually invert, the button hides rather than offer to "revert" an edit it would not touch.
> The server enforces the same rule independently: it will perform the undo, but it will not mark
> a chat edit "Reverted" unless that edit is the one it inverted.

The same bullet later says "The button appears on the latest edit while `/api/docs/:id/undo-status`
(also log-derived — no session lifetime) reports it undoable." That remains true and needs no
change — `/undo-status` is still the source, now additionally reporting *which record* it would
act on.

### 1c. `docs/dev.md` — NOTHING OWED (verified)

Checked: `docs/dev.md` describes local development (pod, DB, test commands) and contains **no**
description of restore or undo behaviour. No correction is owed there.

---

## 2. FR-019 / D17 — an addition beyond the gated task list

The orchestrator adopted analyze-stage finding **N1** after the gate and before implementation.
It is recorded as **D17** in `clarifications-needed.md` (an explicit decision, *not*
ratified-by-default), as **FR-019** and **SC-013** in `spec.md`, and as tasks **T050–T052** in
`tasks.md`. Task count 49 → 52.

**Why it was needed.** The guard D13 planned is client-side only and is fed by
`UndoEditButton`'s 30-second poll. Nothing tells the chat component that a restore happened in
the version-history panel — the two surfaces do not communicate. So for up to 30s after a
restore the modify card still offers Undo, and clicking it inverts the **restore** while stamping
"Reverted" on the **modify**: exactly the lie FR-018 exists to forbid, merely time-boxed. Sam
chose D13's option (c) specifically so that no user-visible lie ships.

**What shipped.** `performUndo`/`performRedo` additively report `actedEditClockStart` (the
`edit_clock_start` of the record actually inverted), and the reverted-flag write is gated on it.
The undo/redo **itself is unchanged in every case** — identity-LIFO target selection stands, per
FR-002 and D16. Only the label is withheld.

**Reviewer note — one small structural change this forced.** The flag-writing logic moved from
`server/index.js` into a new module, `server/undo/reverted-flag.js`. That is not gold-plating:
SC-013 requires proof that the mislabel is impossible *with the client guard bypassed*, and
`index.js` cannot be `require`d from a test without starting the HTTP server. `index.js` keeps
the route; the module holds the rule.

**Fail directions, stated so they are reviewed as intentional:**

| Situation | Direction | Why |
|---|---|---|
| Part has no `editRange.clockStart` (`editRangePending`) | **Fail CLOSED** — flag not written | The acted record is known but the part is unidentifiable; a stamp would be a guess. This is what closes N2 (below). |
| `actedEditClockStart` is `undefined` (legacy-derivation undo) | **Fail OPEN** — flag written as today | Safe *by construction*: that path runs only when the identity has **no** `agent_edits` rows at all in the document, so no competing record — and no restore — can exist to misattribute away from. |

**MCP surface note**: because `handleUndoRedo` passes the service result through, the MCP `undo`
and `redo` tools gain one extra output key (`actedEditClockStart`). Additive and harmless; no
tool description or input schema changed.

---

## 3. Analysed consequences — meet these as decisions, not bugs

### 3a. F5 — two accepted consequences of recording restores under the chat identity

Both are documented **as code comments at their sites**, so the next reader meets them in the
code and not only here:

1. **`server/api/chat-staleness.js`** (`foreignEditsSince`) — a user's own web-UI restore is no
   longer reported as a *foreign* edit, so the "someone else changed this document" warning stays
   silent for it. Correct: the warning exists to say *someone else* moved the document, and this
   is the user's own action in another panel of their own session. A restore by a different user,
   or by an MCP agent token, still carries a different identity and is still reported.
2. **`server/mcp/tools/modify.js`** (`isSelf`) — when the in-app chat assistant runs a `modify`,
   a restore the user performed just beforehand now counts as `isSelf`, so the assistant replays
   it as its own work rather than tripping the conflict guard. Coherent: the restore genuinely
   *was* performed by that user through the assistant identity, and it is the same property that
   makes the restore undoable. **MCP agent tokens are unaffected** — they carry their own
   `agentName`, which never equals the chat-assistant identity.

### 3b. N2 — the client guard fails open for an `editRangePending` modify

A `modify` whose durability wait timed out returns no `editRange`, so the client guard has
nothing to compare and — per D15's mandatory fail-open — offers the button. **That is the
intended consequence of the fail-open rule**, not an oversight: failing closed there would strip
a working Undo button from cards the client cannot identify.

The mislabel risk this leaves is covered by FR-019 server-side, which fails *closed* on exactly
this case. So the button may be offered, the undo may happen — but the part is never labelled
"Reverted" unless the server confirmed it was the record inverted. Pinned by the `(e2)` case in
`UndoEditButton.test.jsx` and the `(N2)` case in `restore-undo-roundtrip.test.js`.

### 3c. N3 — poll staleness

Same window, reached deliberately: status fetched *before* a restore, restore lands, click
arrives on the stale status. **Resolved behaviour, now pinned in tests:** the client *does* issue
the POST (it has no fresher data, and D15 mandates acting on what it has); the server performs
the undo and **refuses to mislabel**; the client re-fetches status in its `finally` and
self-corrects. Covered by `UndoEditButton.test.jsx` `(N3)` and `restore-undo-roundtrip.test.js`
`T052 (N3…)`.

### 3d. The deliberately inverted tests — the reviewer's first stop

Three pre-existing assertions were **inverted on purpose**, each rewritten in place with its
provenance and reason kept in a comment:

| Test | Was | Now |
|---|---|---|
| `version-history.test.js` "T031: human restore … (identity = `''`)" | `agent_name === ''` | `agent_name === 'Squire Docs Assistant'`, in **both** stores |
| `version-history.test.js` "handles updates without user info" | `authors` length `0` | one "Unknown author" entry |
| `HierarchicalVersionList` colour fallback | date-salted palette | stable `#888888` |

The first is the ratified, user-visible attribution tradeoff (FR-003, SC-004). It is the single
most important thing for a reviewer to look at.

### 3e. A test constant that had to change

`server/__tests__/version-history.test.js`'s `AGENT` constant was the literal
`'Squire Docs Assistant'`. That was harmless while human restores used the `''` sentinel, but
once a web-UI restore records under the chat-assistant identity it would make every
cross-identity scoping assertion **vacuous** (T032/040 would be asserting that an identity cannot
undo its own restore). It is now `'Test MCP Agent'`, which is what those tests always meant.

---

## 4. FR-010 — nothing owed; and a rebase the queue must know about

**This branch was rebased onto current `main` (`f43a19b1`) before handoff.** It was originally
branched from `6107b41e`, which predates 039's `61a387af`.

That stale base produced one wrong finding, now **retracted** in `clarifications-needed.md`
**D18**. Implementation briefly concluded that FR-010 had never shipped — `colorUtils` still
imported, the date-salted fallback still in place, the cited test at `:487` absent — and wrote a
fix. All of those observations were true **of the old base** and false of `main`: 039 shipped its
FR-018 in `61a387af`, in exactly the shape 040 wanted, and the cited test exists at line 487
exactly.

**Resolution**: the redundant 040 change was dropped during the rebase in favour of 039's (they
were substantively identical; 039's is better commented). Phase 7 is verification-only after all,
as written. **Nothing is owed here, and no 039 item needs closing.**

D18 is kept rather than deleted because the trap is worth recording: from inside a worktree,
"the task's citation is stale" and "my base is old" look identical, and the second is far more
likely. Check `git show main:<path>` before concluding the former.

## 5. Verification results (T036–T040)

### T036a — no fourth identity comparison escaped the consolidation

```
$ grep -rn "agentName ===\|agentName !==\|agentName ?? null" server/ client/src/ \
    --include=*.js --include=*.jsx | grep -v __tests__
server/agent-identity.js:59:    && (a.agentName ?? null) === (b.agentName ?? null);
server/undo/edit-records.js:115:  if (typeof agentName !== 'string' || agentName.trim() === '') {
server/undo/edit-records.js:119:        typeof agentName === 'string' ? JSON.stringify(agentName) : String(agentName)
server/origin.js:182:      agentName: origin.agentName ?? null,
```

Expected `agent-identity.js` + `origin.js:182` (normalization, deliberately out of scope). The
two `edit-records.js` hits are **not identity comparisons** — they are `typeof` checks inside the
new FR-006 precondition, matched incidentally by the grep pattern. No fourth comparison remains.

### T036b — one authoritative definition of the agent name

```
$ grep -rn "Squire Docs Assistant" server/ | grep -v __tests__
server/agent-identity.js:30:const CHAT_AGENT_NAME = 'Squire Docs Assistant';
server/index.js:1539:    // the restore to "Squire Docs Assistant (<user name>)" rather than the
server/mcp/auth/agent-token-factory.js:16: * @param {string} opts.agentName - Display name (e.g. 'Squire Docs Assistant')
```

One definition, plus two prose mentions (an explanatory comment and a JSDoc example). The former
duplicates in `server/api/chat.js:91` and `server/onboarding.js:18` are gone.

### T037 — no import cycle; the leaf stays a leaf

```
$ grep -c "require(" server/agent-identity.js
0
$ node -e "require('./server/version-history.js'); require('./server/agent-identity.js'); …"
T037 LOAD OK - no import cycle
```

`server/version-history.js` does **not** require `server/api/chat.js`. FR-005's
no-circular-dependency property is structural, held by the zero-`require` invariant stated in the
module header.

### T038 — zero migrations, no forbidden file touched

```
$ git status --porcelain migrations/
(empty)
```

No file under `migrations/` appears in the feature diff (SC-007, FR-014's still-binding clause).
Also confirmed absent from the diff: `server/origin.js`, `server/document-service.js`,
`server/postgres-persistence.js`, the diff subsystem, the websocket/attribution layer.

*(One incidental cleanup: a stray `dump.rdb` — a Redis artifact of the worktree test stack — was
committed and then removed, with an ignore entry added. Not part of the feature.)*

### T039 / T040 — suites

Two runs are recorded: the pre-rebase run (against the stale base) and the authoritative
post-rebase run (against current `main` — this is the one that matters).

| | Baseline (before any change) | Pre-rebase | **Post-rebase (authoritative)** |
|---|---|---|---|
| Backend (`npm run test:server`) | 230 suites / 3971 passed | 232 / 4013 | **236 suites / 4113 passed, 0 failures (212.7s)** |
| Client (`npm run test:client`) | 65 suites / 805 passed | 66 / 817 | **66 suites / 818 passed** |
| `npm run build` | — | green | **green** |

The baseline was fully green — **no pre-existing failures**, so nothing here is masking one. The
two new backend suites are `restore-undo-roundtrip.test.js` and `identity-predicate.test.js`; the
new client suite is `UndoEditButton.test.jsx`. The post-rebase client count is one higher than
pre-rebase because 039's own FR-018 test came in with the rebase while 040's duplicate of it was
dropped, and 040's three FR-009 cases remain.

All backend runs used `DATABASE_URL=…/collab_test_db_040` — this agent's own database — via
`npm run test:server` (never a bare `npx jest`, which hangs on the live Redis client).

---

## 5b. Quickstart walk, section by section (T041)

| Quickstart section | Result |
|---|---|
| 0. Environment | **PASS** (with a deviation — see below) |
| 1. US1 — a web-UI restore is undoable | **PASS**, automated: `restore-undo-roundtrip.test.js` T013/T014/T016 + `undo-status-api.test.js` T015. Byte-exact round trip asserted, not merely "changed". |
| 2. US2 — agent restores do not regress | **PASS**, automated: T017/T018. `restore-document-version.js` verified unchanged by `git diff` (T019). |
| 3. US3 — no silently empty contributor list | **PASS**, automated: T026 (a)–(e) incl. the drill-down path, plus client T027. |
| 4. US4 — an unattributable edit record fails loudly | **PASS**, automated: T020 (guard runs before any query — the persistence double throws if reached) + T021 (restore still succeeds). |
| 5. US5 — history colours are stable | **PASS, verification-only as written** — 039 already shipped it. See §4 and the retracted D18. |
| 5b. US6 — the Undo button never lies | **PASS**, automated: T045/T046/T047/T048, plus T052 for the FR-019 server half. |
| 6. FR-015 — one identity predicate | **PASS**: `identity-predicate.test.js` + the T036a grep in §5. |
| 7. Documentation closures (SC-008) | **PASS** by inspection: sentinel rule and FK rationale in `edit-records.js`; F7 limitation comment at `edit-range.js`. The README half is **owed** — §1. |
| 8. Full gate | **PASS** — see §5 and the final report. |

**Environment deviation worth recording**: the quickstart's section 0 assumes a ready Postgres
and Redis (`createdb collab_test_db_040` against a local socket). In this worktree sandbox
neither server was installed — only the `postgresql-client` binaries. The stack had to be built
first: `postgresql-15` + `redis-server` + `postgresql-server-dev-15` via apt, **pgvector 0.8.0
compiled from source** (the search migrations do `CREATE EXTENSION vector`, so `globalSetup`
fails for the entire suite without it), `pg_hba.conf` set to `trust`, and a `root` role created.
Worth folding into the quickstart if other agents hit the same cold start.

**Second note for the queue**: `server/__tests__/globalSetup.js` checks for the existence of the
hard-coded `TEST_DB_NAME` (`collab_test_db`) but runs migrations against `DATABASE_URL`. With a
per-agent database set, it therefore creates an empty, unused `collab_test_db` as a side effect.
Harmless here, but it means the "per-agent DB" isolation is one line short of complete.

---

## 6. Owed to Sam — cannot be run in a worktree (T041)

Neither can be executed here; both are `promotion-notes.md` OWED-2 items.

1. **Browser walk (US1)**: restore an older version from the version-history panel → confirm
   version history attributes it to "Squire Docs Assistant (<your name>)" → call
   `POST /api/docs/:id/undo` (there is no button for it — that is OWED-1) → confirm the document
   returns to its pre-restore content → `POST /redo` → confirm the restore re-applies.
2. **MCP walk (US2)**: via an agent token, `restore_document_version` → confirm history attributes
   it to the agent → the agent's `undo` inverts it exactly, and the chat assistant's undo does
   **not** see it.
3. **Offer-guard visual (US6)**: with a completed assistant `modify` card on screen, perform a
   restore in the version panel, wait out the 30s poll, and confirm the card's Undo button
   disappears. Then undo the restore via the API and confirm the button returns.

---

## 7. What the merge queue must do

1. Apply the two `README.md` replacements in §1 (**the only file edit owed**).
2. Note D17/FR-019/SC-013 as post-gate additions to the artifacts, and D18 as a **retracted** finding.
3. Nothing owed for 039's FR-018 — it was already delivered; see §4.
4. Leave `promotion-notes.md` OWED-1 (document-level undo affordance) open — still not built,
   deliberately.
5. **The branch is already rebased onto `main` (`f43a19b1`) and re-verified there** — see §4.
   It should apply cleanly. Note that `README.md:467`'s current text on `main` still contains the
   "spec 040" forward reference §1 removes.
