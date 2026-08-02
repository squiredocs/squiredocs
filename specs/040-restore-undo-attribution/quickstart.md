# Quickstart — validating 040-restore-undo-attribution

Runnable validation for the five user stories. Everything here runs from a pipeline worktree.

---

## 0. Environment (worktree — do this first)

Worktrees do **not** inherit `node_modules` or `.env`:

```bash
npm ci && (cd client && npm ci)
cp /local-dev/.env .            # if present; Redis is shared and fine to reuse
createdb collab_test_db_040     # per-agent database — backend tests are serial-only
```

Every backend test command in this document must carry the per-agent database:

```bash
DATABASE_URL=postgres://$(whoami)@localhost/collab_test_db_040 npm run test:server -- <pattern>
```

**Always run backend tests via `npm run test:server`** (or add `--runInBand --forceExit` to a
bare `npx jest`). A live Redis client keeps the process alive: a bare `npx jest` hangs forever
and returns nothing when piped. Client tests (`npm run test:client` / Vitest) and
`npm run build` are worktree-safe and need no database.

---

## 1. US1 — a web-UI restore is undoable (P1, the headline)

**Automated**

```bash
DATABASE_URL=... npm run test:server -- restore-undo-roundtrip
DATABASE_URL=... npm run test:server -- undo-status-api
DATABASE_URL=... npm run test:server -- version-history
```

Expected:

- the round-trip suite proves restore → `canUndo: true` → undo → content **byte-identical** to
  the pre-restore state → redo → restored content re-applied (SC-001, SC-002);
- `version-history` proves a web-UI restore writes **one** `yjs_updates` row **and one**
  `agent_edits` row, **both** carrying `agent_name = 'Squire Docs Assistant'` (FR-001);
- the pre-existing assertion `agent_name === ''` is **gone**, replaced — not deleted (research R9).

**⚠️ Scope (D13)**: US1 is delivered **at the endpoint contract**. There is deliberately **no
UI control** that undoes a restore — see `promotion-notes.md` OWED-1. Do not try to validate
this story by clicking; validate it with the endpoints (or `curl`).

**Manual (app-dev pod)** — owed to Sam, not automatable here:

1. Open a document with at least two versions; note the current content.
2. History → restore an older version. Content changes; the restore appears in history,
   attributed to "Squire Docs Assistant (&lt;your name&gt;)" (FR-003/SC-004).
3. `GET /api/docs/<id>/undo-status` reports `canUndo: true` and a `nextUndo.editClockStart`.
4. `POST /api/docs/<id>/undo` — content returns **exactly** to step 1.
5. `POST /api/docs/<id>/redo` — the restored content comes back.
6. Reload the page (or restart the server) between steps 2 and 4 — availability must survive,
   because it is log-derived (SC-002).

## 2. US2 — agent restores do not regress (P1)

```bash
DATABASE_URL=... npm run test:server -- restore-undo-roundtrip
DATABASE_URL=... npm run test:server -- mcp
```

Expected: an MCP restore still records under the **agent token's own** name in both tables; that
agent's MCP `undo` inverts it; and a *different* identity (the same user's chat assistant)
sees nothing to undo — identity scoping per 016 FR-024 (SC-003).

**Manual (MCP client)**: `restore_document_version` then `undo` on the same token — the restore
inverts, and version history attributes it to the agent, not to the assistant.

## 3. US3 — no silently empty contributor list (P2)

```bash
DATABASE_URL=... npm run test:server -- version-history
npm run test:client -- HierarchicalVersionList
```

Expected:

- a version built entirely from rows with `user_id = NULL` renders exactly **one** contributor,
  `Unknown author`, `id: null`, `color: '#888888'`, `isAgent: false`;
- a mixed version renders the real authors **plus** exactly one unknown entry;
- the **sub-version drill-down** gets the same treatment (it shares
  `groupUpdatesIntoVersions`, so one assertion per path proves it);
- the client renders an author with `id: null` without crashing or emitting a blank badge
  (FR-009).

**Manual**: hard to stage without deleting a user; the automated coverage above is the gate.

## 4. US4 — an unattributable edit record fails loudly (P2)

```bash
DATABASE_URL=... npm run test:server -- edit-records
DATABASE_URL=... npm run test:server -- version-history
```

Expected:

- `recordEdit` with `agentName: null` (and with `undefined`, `''`, `'   '`, and a non-string)
  **throws before any query** — assert the pool was never called, and assert the message names
  the missing identity;
- no raw `null value in column "agent_name" violates not-null constraint` can reach a log for
  this path (SC-006);
- the enclosing restore still **succeeds** and the failure is logged (D6 non-fatal parity) —
  the existing `version-history.test.js` case that pins this must still pass.

## 5. US5 — history colors are stable (P3) — **verification only**

```bash
npm run test:client -- HierarchicalVersionList
```

Expected: **no code change in this feature.** Feature 039 already shipped FR-018, the identical
requirement. Confirm by inspection that:

- `client/src/components/HierarchicalVersionList.jsx` renders
  `backgroundColor: author.color || '#888888'` and does **not** import `colorUtils`;
- the existing case "renders the stable neutral #888888 for a colorless author, on any date"
  passes;
- `client/src/utils/colorUtils.js` still has its date-salted presence palette, untouched
  (FR-010's second half — presence rotation must not change).

## 5b. US6 — the Undo button never lies about what it will undo (P1)

```bash
DATABASE_URL=... npm run test:server -- undo-status-api
DATABASE_URL=... npm run test:server -- restore-undo-roundtrip
npm run test:client -- UndoEditButton
```

Expected:

- `/undo-status` carries `nextUndo.editClockStart` when a record backs the answer, and **omits**
  it (not `null`) when `canUndo` is false or the legacy-derivation fallback answered;
  `canUndo`/`canRedo` are byte-identical to today (FR-016, SC-011);
- the reported `editClockStart` is **stable across an undo→redo cycle** (proves D14's choice of
  the immutable field over the rewritable target range);
- with a restore as the next undo target, a `modify` card renders **no** Undo button, and no
  request path exists that could stamp "Reverted" on it (SC-010(a), SC-012);
- with that modify as the next target, the button is offered exactly as today (SC-010(b));
- with either value missing (`nextUndo` absent, or `editRange` absent because the modify's
  durability wait timed out), the button is **offered** — fail-open, never fail-blank
  (SC-011, US6 scenario 5);
- the endpoint still inverts the identity's true next target in every case (SC-010(c)).

**Manual (browser)** — owed to Sam: with an assistant `modify` card showing its Undo button,
restore a version from the history panel; the card's Undo button must disappear. It must come
back once that modify is the next target again.

## 6. FR-015 — one identity predicate (SC-009)

```bash
DATABASE_URL=... npm run test:server -- identity-predicate
DATABASE_URL=... npm run test:server -- undo
```

Expected: the three undo surfaces (`edit-range` durability filter, `inverse` identity filter,
`legacy` run detector) all classify a DB-shaped row `{ userId: U, agentName: null }` as
belonging to an in-process identity `{ userId: U }` with **no** `agentName` key. Before this
feature `edit-range` disagreed.

**Reviewer grep (SC-009 requires this to be run and its result recorded):**

```bash
grep -rn "agentName ===\|agentName !==\|agentName ?? null" server/ client/src/ \
  --include=*.js --include=*.jsx | grep -v __tests__
```

Expected remaining hits: **only** `server/agent-identity.js` (the predicate itself) and
`server/origin.js:182` (normalization, not comparison — deliberately out of scope). Any other
hit must be converted or filed explicitly.

Also confirm the constant has exactly one server-side definition:

```bash
grep -rn "Squire Docs Assistant" server/ | grep -v __tests__
```

Expected: `server/agent-identity.js` (the definition) and a JSDoc example in
`server/mcp/auth/agent-token-factory.js:16`. `server/onboarding.js` must no longer define its
own literal.

## 7. Documentation closures (SC-008) — inspection

- `server/mcp/yjs/edit-range.js` — header/inline comment at the identity filter documenting the
  accepted display-name-equality limitation (FR-011, F7).
- `server/undo/edit-records.js` — the single `agent_name` sentinel rule (FR-007) **and** the
  FK-policy divergence rationale (FR-012), both in module documentation.
- `merge-notes.md` — carries the **exact replacement text** for **both** stale README passages,
  for the merge queue to apply (FR-013 + finding F6): `README.md:467` (the restore paragraph)
  and `README.md:583` (the "most recent `modify` diff has an Undo button that reverts the edit"
  sentence, now conditional on being the next undo target). The implementing agent must not edit
  `README.md` itself.
- `promotion-notes.md` — OWED-1 (the document-level undo affordance, deliberately not built)
  and OWED-2 (manual walks owed to Sam) are accurate about what shipped.

## 8. Full gate before handing to the merge queue

```bash
DATABASE_URL=postgres://$(whoami)@localhost/collab_test_db_040 npm run test:server
npm run test:client
npm run build
```

All three green. **Zero new files under `migrations/`** — verify with `git status migrations/`
(SC-007).
