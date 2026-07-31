# Clarifications ledger — 037-import-presence (spec phase)

Per the parallel-agent rules: no user interaction; each open product decision got the best
default and is recorded here as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-31)**.
Overturn any of these by amending the spec before plan/implement consumes it.

Design ground truth: `design/markdown-import-two-way-sync.md` — "Amendment (Sam,
2026-07-30) — imports announce presence (feature 037)" — and
`design/agent-surface-mcp.md` — "Amendment (Sam, 2026-07-30) — REST imports join the
presence model (feature 037)" plus the reads-never-write amendment (2026-07-21). Context:
`design/collaboration-core.md` (awareness, Redis fan-out, presence-claim dedup).

## Already ratified by Sam (2026-07-30) — recorded, not defaults

The six amendment bullets are **RATIFIED BY SAM** and are encoded in the spec verbatim,
not relitigated:

1. **Mechanism — reuse agent-presence, no new relay code.** Update-mode imports (append,
   replace, sync) open the same server-side presence session the MCP tools and chat use,
   so presence-claim dedup and cross-instance awareness fan-out apply unchanged. Credential
   for the session dial: recover the bearer from the request, or mint a synthetic agent
   token pair (chat pattern) — implementation may choose (spec leaves this to the plan,
   per the amendment's own latitude). Agent identities only; human-session imports skip
   presence; the create-mode import is excluded. Spec: FR-001..FR-005, US1.
2. **Timing — presence spans the whole request.** Session opens after auth + editor-role
   gates, before parsing and the image pass; refreshed at apply; lingers ~60 s after the
   response, then auto-cleans. Spec: FR-006, FR-007.
3. **Best-effort invariant.** Presence never fails, blocks, or materially slows an import:
   ~2 s awaited cap then fire-and-forget; errors logged, import unchanged. Spec: FR-008,
   FR-009, US3.
4. **Visuals v1 — avatar + cursor + temporary selection.** Standard agent avatar/cursor
   plus the existing ~10 s temporary selection over the changed range (append: appended
   blocks; replace: imported content; sync: first-to-last changed block). No modify-style
   highlight sweep. Reads-never-write applies to every position computation. Spec:
   FR-010..FR-014.
5. **Identity — presence mirrors row attribution; names fixed at mint time.** Presence
   label always matches the version-history author ("TokenName (UserName)" for
   append/replace; the sync agent name, default "Repo Sync", for sync). No per-request
   label override. Companion contract: the import-recipe tool and the general
   token-minting tool mint concise default names; existing tokens keep their names.
   **Corrected by Sam (RATIFIED, 2026-07-31; design commit 545e10b)**: token display
   names describe the AGENT the token serves, not the operation — derived from the MCP
   client identity where available (e.g. "Claude Code"), with the tool contract telling
   agents to name the token after themselves. The name answers "who is here", not "what
   operation ran"; operation names like "Markdown sync" are wrong. This is a Sam-ratified
   decision, not a default. Spec: FR-015..FR-017a, US4, US5.
6. **Folded-in fix — cross-pod content fan-out.** Import append/replace and sync push
   content changes must always reach live viewers on other replicas (live-apply publish
   pattern or equivalent); the spec states the outcome and leaves the mechanism —
   including the capture-update-and-publish shape needed where imports transact on the
   shared doc — to the plan, per the amendment. Spec: FR-018, FR-019, US2.

## RATIFIED-BY-DEFAULT decisions

1. **No-op imports announce presence but show no selection** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-31).
   *Question*: when an import changes nothing (canonicalization yields an empty diff on a
   sync push, or an append of empty content), is a temporary selection shown, and does
   presence still occur?
   *Why it matters*: the visuals bullet defines the selection per changed range but is
   silent on the empty range; a zero-length selection is meaningless and a fabricated one
   would misreport a change.
   *Rationale*: the agent genuinely arrived and inspected the doc, so presence (which
   opens before the diff is known) stays; with no changed range there is nothing truthful
   to select, so no selection. Matches "presence mirrors attribution": no version entry,
   no highlighted change. Spec: FR-012, edge case "No-op sync push".

2. **Failed imports do not tear presence down synchronously** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-31).
   *Question*: if the import errors after the session opened (validation failure, size
   cap, sync baseline rejection), is the presence session actively removed?
   *Why it matters*: an agent avatar lingering ~60 s after a failed import could read as
   "it did something"; but active teardown adds a failure-path coupling the best-effort
   invariant exists to avoid.
   *Rationale*: the timing bullet says the session "lingers for the session TTL … then
   auto-cleans" with no teardown carve-out, and the best-effort invariant forbids presence
   work from complicating the import path. An agent that arrived and failed genuinely was
   there; no content change is shown because none happened. Spec: edge case "Import fails
   after presence opened".

3. **Standard presence defaults, no new tunables** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-31).
   *Question*: are the session lifetime (~60 s), the ~2 s attach cap, and the ~10 s
   selection duration new configuration knobs for the import surface?
   *Why it matters*: every "~" in the amendment could be read as an invitation to add
   config.
   *Rationale*: the amendment's tildes reference the machinery's existing defaults
   ("lingers for the session TTL (~60 s)", "the existing 10-second temporary-selection
   mechanism"); this feature adds callers, not capabilities, and new tunables would be
   ceremony (Constitution Principle III). Values stay the shared machinery's defaults;
   the ~2 s cap is a constant, not config. Spec: Assumptions; FR-007, FR-009, FR-011.

4. **Caller-supplied token names always win; only mint defaults change** —
   RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-31).
   *Question*: the naming bullet says the minting surfaces mint agent-descriptive display
   names — does that override a name the caller explicitly passes to the general
   token-minting tool?
   *Why it matters*: the general minting tool accepts an explicit name parameter today;
   silently rewriting a caller's chosen name would be surprising and lossy.
   *Rationale*: the amendment targets "the current verbose 'Minted by … via …'" strings,
   which are the *defaults* applied when no name is given, and the corrected bullet
   (Sam, 2026-07-31) steers caller choices through the tool contract ("name the token
   after themselves") rather than by overriding them. Only the default strings and the
   contract guidance change; an explicit caller name is honored unchanged. Spec: FR-017,
   FR-017a, US5 scenario 2.

5. **Pre-apply cursor uses the standard session placement (document start)** —
   RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-31).
   *Question*: where does the agent's cursor sit during the pre-apply window (parsing,
   image pass), before a changed range exists?
   *Why it matters*: the amendment fixes arrival timing but not the initial cursor
   position; some position must be shown for the potentially tens-of-seconds window.
   *Rationale*: the shared presence machinery already initializes a new session's cursor
   at the document start; reusing that (per the "no new relay code" mechanism bullet)
   means zero new position logic before apply, and reads-never-write is already honored
   there. Spec: FR-010 ("standard agent presence"), US1 scenario 2.

6. **Content fan-out failure is logged, never fails a persisted import** —
   RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-31).
   *Question*: if the cross-replica publish of the content update fails (e.g. the pub/sub
   backend is briefly down) after the import has applied and persisted, does the import
   return an error?
   *Why it matters*: the best-effort bullet covers presence, not the folded-in fan-out
   fix; the failure mode of the delivery half is unstated.
   *Rationale*: persistence is authoritative and has already succeeded — failing the
   response would tell the caller a successful import failed, and the pre-037 status quo
   (no fan-out at all) was never an import error. Delivery degradation is logged and
   viewers converge on reconnect/reload, matching the existing live-apply precedent used
   by undo and restore. Spec: FR-018/FR-019 scope the outcome to delivery, not the
   import's success contract.

## RATIFIED-BY-DEFAULT decisions added at PLAN phase (2026-07-31)

7. **Sync presence dedups per user+document, not per token** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-31).
   *Question*: the presence session key is `${userId}-${agentId}-${docGuid}`. For mode=sync the
   label must be "Repo Sync", not the token's name — so what `agentId` does the sync session use?
   *Why it matters*: reusing the token's `agentId` (`api-token:<id>`) with a different display name
   would make two concurrent imports on the same token flip one session's label back and forth
   (`getOrCreateSession` rewrites `session.agentInfo` on the reuse path); giving each token its own
   sync identity would show several "Repo Sync" avatars for one user on one document.
   *Rationale*: version history attributes every sync push to `(userId, 'Repo Sync')` regardless of
   which token pushed it, so the truthful dedup granularity is exactly user+doc. The sync session
   therefore uses a fixed `agentId` of `'repo-sync'`; append/replace keep `req.user.agentId` so they
   still dedup against MCP tool sessions on the same token (FR-002). Plan: research R2; plan.md
   identity table.

8. **A pure-deletion changed range shows no selection** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-31).
   *Question*: a sync push whose net effect on a region is deletion leaves a zero-width span after
   apply. Is a selection shown (collapsed cursor / neighbouring block), or none?
   *Why it matters*: FR-011 defines the sync range as "first through last changed block", which is
   undefined when the changed blocks no longer exist.
   *Rationale*: the same logic as RBD-1 — there is nothing truthful to select, and selecting a
   surviving neighbour would misreport unchanged content as changed. `createBlockRangeSelection`
   already returns `null` for an inverted/out-of-bounds range, so this falls out of the existing
   helper with no special-casing: no range ⇒ no `setTemporarySelection`. The agent is still visibly
   present. Plan: research R4; data-model §3.

9. **The presence session opens before the request's cheap validations** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-31).
   *Question*: "right after the auth and editor-role gates" — does that mean before or after the
   route's own body/receipt-option validation and (for sync) baseline validation?
   *Why it matters*: opening first means a malformed request (empty body, bad `flavor`, stale
   baseline) leaves an agent avatar visible for ~60 s having changed nothing.
   *Rationale*: the design bullet is literal ("right after the auth and editor-role gates, before
   parsing and the image pass"), and the spec's own edge case explicitly contemplates presence being
   already open when an import fails with a "validation error, size cap, baseline rejection" — which
   is only possible if the session opens before those checks. An unknown `mode` still 400s before any
   presence (it is not an update-mode import at all). Plan: research R5; contracts/import-presence.md.

10. **`create_access_token` gains an optional `name` parameter** — RATIFIED-BY-DEFAULT
    (Sam pre-authorized, 2026-07-31). **Contract addition — flagged for review.**
    *Question*: FR-017 says "caller-supplied names remain honored" and FR-017a says the tool contract
    must tell agents to name the token after themselves — but `create_access_token` has **no name
    parameter today** (inputSchema = `scopes`, `ttlSeconds`, `inline`). Is the affordance added?
    *Why it matters*: without it, two ratified requirements are unimplementable, and the only way an
    agent could influence its own presence label would be not to exist. The alternative reading —
    that "caller-supplied" refers to a hypothetical future parameter — would make FR-017a a no-op.
    *Rationale*: the design amendment's mechanism is explicitly "the tool contract telling agents to
    name the token after themselves", which presupposes a name the agent can supply. Adding one
    optional string parameter is the minimum that makes the ratified contract real; the default path
    (no name) is unchanged in shape and simply produces an agent-descriptive string instead of a
    provenance string. `import_markdown_file` deliberately does **not** get the parameter — it is a
    zero-argument recipe tool. Plan: research R6; contracts/token-naming.md.

*Plan-mechanism note (not a product decision)*: FR-005 leaves the WS-dial credential to the plan. The
plan chooses the **synthetic agent token pair** (the chat pattern) over recovering the raw bearer,
because the bearer cannot express the "Repo Sync" identity mode=sync requires and because it would
widen raw-secret handling. Full rationale in research.md R2.

## Implementation-phase decisions (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-31)

Recorded by the implementer. Each is a placement/coverage judgment inside an already-ratified
contract, not a new product decision.

- **RBD-11 — the sync observer wraps `applySyncPush`, not `handleSyncPush`.**
  contracts/import-presence.md shows the observer wrapping `handleSyncPush` from the route. It is
  instead registered inside `handleSyncPush` around the `applySyncPush` call.
  *Rationale*: identical coverage of the applying transaction with a strictly shorter observation
  window, and the baseline-rejection early returns (400/403/409/410) then cannot leak an observer at
  all — they return before it is ever registered. `stop()` still runs in a `finally`.

- **RBD-12 — F9 and the sync fan-out assertions live in `server/__tests__/live-fanout.test.js`.**
  tasks.md T012 named `__tests__/integration/redis-sync.test.js` and T018 named
  `server/__tests__/markdown-sync.replay.test.js`.
  *Rationale*: redis-sync.test.js is a pure in-memory pub/sub simulation with no DB, persistence or
  documentService harness, and markdown-sync.replay.test.js is pure-unit and never reaches
  `applySyncPush`'s store-then-apply tail — the code actually under test. Both assertions need the
  real import path, which live-fanout.test.js already stands up. Grafting a DB harness onto either
  suite would have tested less, not more.

- **RBD-13 — FR-007's ~60 s linger is manual-only coverage.**
  Per implementer brief section 4, stated explicitly here and in the commit message. The suite pins
  the half this feature owns: the apply-time refresh re-presents the *same* token, duration and
  `requiredRole`, which is exactly what routes it down agent-presence's reuse path and re-arms
  `_setSessionTimeout`. That the re-armed timeout then expires unattended is agent-presence's own
  behavior, and its reuse path gates on `provider.wsconnected` — asserting it needs a live WS
  provider, not a double. quickstart.md scenario A now carries the obligation explicitly.

- **RBD-14 — `agent-presence._buildAgentInfo` is exported as a test seam.**
  The US4 identity-parity assertions must compare against the *shipped* label shape rather than a
  copy of it. Added alongside the module's existing `_sessionsByKey` test seam; no behavior change.

- **RBD-15 — two pre-existing assertions on the old minted-token names were updated.**
  `create-access-token.test.js` and `token-claim.test.js` asserted
  `"Minted by <agent> via MCP"` / `"… via import_markdown_file"`. These are the ratified FR-017
  behavior change landing, not broken tests; both now assert the agent-descriptive name and the
  create_access_token one additionally asserts the old string is *absent*.

## Explicitly deferred (flagged, not decided here)

- **Undo targets for REST imports.** REST imports do not record agent-edit undo rows, so
  the log-derived undo/redo tools cannot revert an import; 037 makes imports *visible*
  live, which will likely make users want to undo them, but the amendment is silent and
  wiring imports into the undo chain is a materially separate design (edit-row recording
  for append/replace/sync, sync-push semantics under undo). Deferred as a candidate
  follow-on question for Sam; explicitly out of scope in the spec (Assumptions, Out of
  Scope).
