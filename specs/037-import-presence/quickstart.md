# Quickstart / Validation Guide — 037-import-presence

How to prove the feature works. Details live in [contracts/](./contracts/) and
[data-model.md](./data-model.md); this file is the run guide.

**Prerequisites**: work happens inside the Minikube `app-dev` pod (`docs/dev.md`). Backend Jest suites
share one database and **must** run serially — never launch two backend runs at once
(Constitution Principle II).

---

## 1. Automated suites

```bash
# whole backend suite (serial by construction: --runInBand)
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run test:server"

# focused, while iterating
kubectl exec deployment/app-dev -n collab -- sh -c \
  "cd /local-dev && npm run test:server -- import-presence live-fanout api-docs-import markdown-sync"
```

Expected: all green. The LLM reporter collapses passing suites to one line; only failures expand.

Coverage map — assertion ids are defined in the contracts:

| Area | Suite | Assertions |
|---|---|---|
| Presence orchestration | `server/__tests__/import-presence.test.js` (new) | C1–C9, C11–C13 |
| Reads-never-write | `server/__tests__/import-presence.test.js` | C10 / SC-005 |
| Fan-out unit | `server/__tests__/live-fanout.test.js` (new) | F1–F8 |
| Route integration | `__tests__/integration/docs-import-api.test.js`, `sync-push.route.test.js` | C1–C5, C9 |
| Cross-instance delivery | `__tests__/integration/redis-sync.test.js` | F9 / SC-003 |
| Mint naming | `server/mcp/__tests__/tools/create-access-token.test.js`, `tools/import-markdown-file.test.js` | N1–N7 / SC-007 |

---

## 2. Manual scenario A — watch an agent import (US1, SC-001, SC-002)

Reproduces the 2026-07-30 observation.

1. Mint an editor-capable token (Settings → API Tokens, or `create_access_token` with
   `documents:read` + `documents:write`) named something agent-like, e.g. `Claude Code`.
2. Open the target document in a browser as a user who can see it. Keep it visible.
3. From a shell:

   ```bash
   curl -sf -X PUT -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: text/markdown" --data-binary @big-doc.md \
     "$BASE/api/docs/$DOC/import?mode=append"
   ```

   Use a body with a few images so the pre-apply image pass takes visible seconds.

**Expected**, in order:

- an agent avatar labeled `Claude Code (<Your Name>)` (robot/agent styling) appears **before** any
  content changes, and stays for the whole pre-apply window (US1 scenarios 1–2);
- the appended blocks land and are covered by a temporary selection in the agent's color, which clears
  itself after ~10 s (US1 scenario 3);
- the avatar disappears on its own ~60 s after the import, with no manual action (US1 scenario 6).

Repeat with `?mode=replace` (selection spans the whole imported document) and with `?mode=sync`
(selection spans the first through last changed block; the label reads `Repo Sync (<Your Name>)`).

Then run the same token's import twice back-to-back: **at most one** avatar for that identity appears
at any moment (US1 scenario 7).

> **This scenario carries the only coverage of FR-007's ~60 s linger.** The automated suite pins the
> half this feature owns — that the apply-time refresh re-presents the *same* token, duration and
> `requiredRole` to `getOrCreateSession`, which is exactly what routes it down the reuse path that
> re-arms `_setSessionTimeout`. That the re-armed timeout then expires unattended is agent-presence's
> own behavior and its reuse path gates on `provider.wsconnected`, so asserting it needs a live WS
> provider. The third bullet above (avatar disappears on its own ~60 s after the import, no manual
> action) is therefore **manual-only** and must actually be walked before ship.

---

## 3. Manual scenario B — identity matches history (US4, SC-006)

After scenario A, open version history for the document.

- append/replace ⇒ the new version's author is the token's name — the same string that was on the
  cursor.
- sync ⇒ the author is `Repo Sync` (with on-behalf-of provenance if headers were sent), matching the
  label that was shown.

Any disagreement between the two is a hard failure of FR-015.

---

## 4. Manual scenario C — cross-replica delivery (US2, SC-003)

Needs two replicas (production topology of record) or two local server processes sharing Postgres and
Redis.

1. Connect a viewer through replica **A** (open the document in a browser routed to A).
2. Ensure replica **B** holds **no** connection for that document (freshly started, or a doc nobody
   opened there).
3. Send each of the three modes' imports directly at replica B.

**Expected**: the viewer on A sees the content change live, no reload, for all three modes. Before this
feature, append/replace and sync from a connection-less replica were invisible until reload.

Also verify the negative: with both replicas relaying the document, an import produces **one**
application of the change — no duplicated blocks, no echo (US2 scenario 3).

---

## 5. Manual scenario D — presence never breaks an import (US3, SC-004)

Exercised by tests, but worth confirming by hand once:

1. Stop Redis (or point `WS_HOST` at an unreachable host) so the presence dial cannot succeed.
2. Run each import mode.

**Expected**: every import returns its normal `200` with the usual receipt; a warn is logged; total
latency is at most ~2 s above baseline. Nothing about the response body, status code, or stored
document differs.

---

## 6. Manual scenario E — token names (US5, SC-007)

1. From an MCP client registered as e.g. "Claude Code", call `import_markdown_file` and
   `create_access_token()` with no `name`.
2. Check Settings → API Tokens.

**Expected**: names read like collaborators (`Claude Code`), not like audit records
(`Minted by Claude via import_markdown_file`) and not like operations (`Markdown sync`).
`create_access_token({ name: "Repo CI" })` stores `Repo CI` verbatim. Tokens created before the feature
keep their old names.

---

## 7. Ship checklist

- [ ] `npm run test:server` green (serial), `npm run test:client` green (unchanged, but confirm)
- [ ] Scenarios A–E walked at least once
- [ ] `README.md` updated in the same commit (Principle I): imports announce presence; import content
      now fans out cross-replica; minted-token naming + the new `create_access_token` `name` parameter
- [ ] Ledger entries RBD-7…RBD-10 present in `clarifications-needed.md`
- [ ] **No migration** was added (this feature needs none — if one appears, stop: migration slots are
      serialized across features)
