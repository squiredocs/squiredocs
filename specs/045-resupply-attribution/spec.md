# Feature Specification: Resupply Attribution — Truthful Author Display for Sync-Resupplied Content

**Feature Branch**: `045-resupply-attribution` (parallel-pipeline feature; work happens on `main` per pipeline overrides)

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "045-resupply-attribution — truthful author display for sync-resupplied content"

**Source material**: `/local-dev/tmp/045-resupply-attribution-investigation.md` (2026-08-02 orchestrator-commissioned investigation). Every code anchor this spec relies on was spot-checked against the working tree on 2026-08-02 by this spec's author (see Verification Notes).

**Design ground truth**: `design/collaboration-core.md`, specifically the 2026-08-02 amendment "the publish-before-commit window is an attribution problem first (feature 045)". That amendment is this feature's ratified design contract and umbrella decision (recorded as RBD-045-1). The 038 amendment's via_sync contract also binds: a via_sync row proves the content reached the server *through* that client, never that the client wrote it; `via_sync` NULL is never suspicious.

## Product framing

When a server instance dies between broadcasting an edit and durably committing it, the edit survives in every connected client's local replica. On reconnect, the sync handshake's catch-up reply re-supplies it, and the durable log stamps the row with the *relaying* user's identity plus `via_sync=true`. The marking is correct — but nothing that displays authors reads it. The version timeline, the drill-down, the per-clock author, and the MCP "recent authors" all present the relayer as the author of content they never wrote. With n connected clients, the wrong person wins the reconnect race with probability (n−1)/n. This feature makes every author-displaying surface tell the truth: resupplied content is credited to its true author where that can be derived from the update's own embedded origin evidence, and honestly labeled as a synced contribution where it cannot — never, in any case, to the relayer. It also closes a related detection blind spot in the collaboration guardrail, and formally records the underlying durability window as an accepted residual rather than an unexamined gap.

## Sequencing & Interlocks (binding)

- **Implements after 044 merges.** Work starts once 044 (presence-awareness guard) is on `main`.
- **Builds on 041's merged state, and MUST NOT re-implement it.** Feature 041 (implementing now) introduces range-scoped author computation (`computeRangeMeta`) and the `UNKNOWN_AUTHOR` handling this feature's surfaces build on. This spec is written against the post-041 target of `server/version-history.js`. If 041's merged behavior differs in detail from its spec, 041's merged behavior wins and the mismatch is noted in this feature's ledger.
- **MUST merge before 043.** 043's US2/FR-003 end-to-end test asserts "the version timeline does not credit the relaying client for relayed content" — that is the behavior *this* feature delivers; the assertion is RED until 045 lands. Note: 043's own spec currently states only "merges last, after 041 and 042" — the orchestrator must extend that ordering to include 045 (flagged in this feature's ledger, RBD-045-7).
- **MUST NOT disturb 043 US3.** 043's US3 pins the publish-before-commit *loss* behavior as a characterization test tied to the 038 FR-018 no-product-fix boundary. This feature deliberately leaves the write/broadcast ordering untouched (see FR-014), so that characterization stays valid.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Resupplied content credits its true author, never the relayer (Priority: P1)

Two people (or a person and an agent) are editing a shared document. A server incident loses one author's just-broadcast edit from durable history; another collaborator's client happens to reconnect first and re-supplies it. When anyone later opens version history, the resupplied content is credited to the person who actually wrote it — recovered from the origin evidence embedded in the update itself — not to whoever's client relayed it back.

**Why this priority**: This is the direct attribution lie: the product's promise is 100% accurate attribution, and today the timeline displays a false author for every mis-stamped resupply. It is the core of the ratified design amendment.

**Independent Test**: Stage a loss-and-resupply (edit by A persisted-then-removed or blocked from commit; B's client holds it and reconnects first) so a `via_sync=true` row stamped with B's identity carries A's content. Open the version timeline and drill-down: A is displayed as the author; B is not credited for it.

**Acceptance Scenarios**:

1. **Given** users A and B connected to a document where A has prior attributed edits, **When** an edit of A's is lost from durable history and re-supplied through B's reconnecting client (a `via_sync` row stamped with B), **Then** the version timeline displays A as the author of that contribution and does not list B for it.
2. **Given** the same row, **When** the version is expanded into its individual edits, **Then** the drill-down shows the same resolved author (A) with the same accounting the timeline uses — the two never disagree.
3. **Given** A's own client reconnects first and re-supplies A's own edit (the genuine offline-edit shape 038 protects), **Then** A remains credited exactly as if the edit had been live — no regression of the 038 promise, and no "synced" hedging on content whose author is its own relayer.
4. **Given** an agent's edit is lost and re-supplied through a human collaborator's browser, **Then** the displayed author is the agent (with its normal agent presentation), not the human.
5. **Given** rows with `via_sync` NULL or false, **Then** their display is completely unchanged by this feature (null is never suspicious — 038 contract).

---

### User Story 2 - Unmappable synced content is honestly labeled, never guessed (Priority: P1)

When resupplied content's true author cannot be derived (no prior attributed evidence, ambiguous evidence, or a deletion-only payload), version surfaces show it as a synced contribution — an honest "this arrived via sync; its author is not determinable" entry — rather than either crediting the relayer or guessing.

**Why this priority**: The fallback is what makes the rule safe. Without an honest fallback, unmappable rows would force a choice between the old lie (relayer) and a new one (a guessed author). Same P1 cluster as US1 — the two ship together or the surface still lies somewhere.

**Independent Test**: Stage a resupply whose origin evidence is absent (the original client has no prior attributed rows in the document). The timeline/drill-down show a synced-contribution entry for it; the relayer is not credited; no real user is fabricated.

**Acceptance Scenarios**:

1. **Given** a `via_sync` row whose embedded origin has no prior attributed rows in the document, **When** any author surface renders it, **Then** it appears as a synced/unknown contribution — visually and semantically distinct from a real author entry — and the relayer's stamped identity is not shown as its author.
2. **Given** a `via_sync` row whose origin evidence is contradictory (the same embedded client identity maps to different users in prior rows), **Then** the system treats it as unmappable (never guesses between candidates) and renders the synced contribution.
3. **Given** a `via_sync` row that carries only deletions (no inserted content), **Then** no deleter is fabricated from the deletion payload's own identifiers (those identify the *deleted* content's author, not the deleter); the row follows the unmappable rendering.
4. **Given** a version whose rows are entirely unmappable `via_sync` rows, **Then** the version renders with the synced contribution as its contributor rather than an empty or relayer-credited author list.
5. **Given** the deleted-account "Unknown author" entry (040 FR-008) and the synced contribution both appear in one version, **Then** they remain distinguishable — they state different facts (identity deleted vs. authorship not determinable from sync relay). [RBD-045-2]

---

### User Story 3 - Every author-displaying surface tells the same truth (Priority: P2)

The rule is not just for the timeline: the per-clock author shown when viewing content at a specific point in history, and the "recent authors" agents receive when reading a document, obey the same resolution — one row resolves to one answer everywhere.

**Why this priority**: A truth fix that covers only the timeline moves the lie instead of ending it; agents act on the MCP recent-authors list, so a lying feed there propagates misattribution into agent behavior. P2 only because the timeline (US1/US2) is the highest-traffic surface.

**Independent Test**: For a staged mis-stamped resupply row, request the content-at-clock view for that clock and an MCP document read that reports recent authors: both report the resolved author (or the synced contribution), never the relayer, and both agree with the timeline.

**Acceptance Scenarios**:

1. **Given** a `via_sync` row at clock N with a resolvable true author, **When** the per-clock author for clock N is displayed, **Then** it is the resolved author, not the stamped relayer.
2. **Given** the same row is unmappable, **When** the per-clock author is displayed, **Then** it is the synced/unknown rendering, not the stamped relayer.
3. **Given** a recent editing session ending in `via_sync` rows, **When** an agent reads the document and receives recent authors, **Then** the list contains resolved true authors and/or the synced contribution, and never credits the relayer for relayed content.
4. **Given** any single `via_sync` row, **When** it is displayed by the timeline, drill-down, per-clock, and recent-authors surfaces, **Then** all four report the identical resolution outcome for it (one resolution, many renderers).

---

### User Story 4 - The collaboration guardrail sees deletions of resupplied agent content (Priority: P2)

The guardrail that alerts when a human-attributed update deletes freshly created agent content must not go blind when that agent content reached the log via a resupply through a human connection (where the row carries no agent name). Detection coverage extends to resupplied agent content; the guardrail's alert-only, never-block posture is unchanged.

**Why this priority**: The guardrail exists to make the 021 class of silent agent-content loss visible. The resupply path recreates its blind spot: exactly the content most likely to be confusing (it flickered through a loss window) is exactly the content the watchdog cannot see. P2 because it is an observability net, not a user-facing display.

**Independent Test**: Stage agent content re-supplied through a human connection (`via_sync=true`, no agent name), then have a human delete it within the guardrail's freshness window: the guardrail alert fires (annotated as sync-sourced per the existing 038 annotation); nothing is blocked.

**Acceptance Scenarios**:

1. **Given** fresh agent-authored content that entered the log as a `via_sync` row through a human connection, **When** a human-attributed update deletes it within the guardrail's freshness window, **Then** the guardrail detects the overlap and raises its alert, annotated as sync-sourced.
2. **Given** the same situation, **Then** the edit is never blocked or rejected — the guardrail's posture (alert-only) is byte-for-byte preserved.
3. **Given** ordinary directly-attributed agent rows, **Then** the existing detection path behaves exactly as before (the fix widens the candidate set; it never narrows it).
4. **Given** a fresh `via_sync` row whose origin cannot be resolved, **Then** the guardrail treats it conservatively (covered rather than ignored) — a blind spot is worse than an occasional benign alert in an alert-only system. [RBD-045-4]

---

### User Story 5 - The durability window becomes a first-class documented accepted residual (Priority: P3)

The underlying publish-before-commit durability window itself is not fixed by this feature — that is a ratified decision, not an omission. This story makes the decision auditable: the residual is recorded in the accepted-residuals ledger entry for Sam's ratification, with its scope, mitigations, frequency, and revisit path stated, and the surrounding documentation cross-references it.

**Why this priority**: Recording is cheap and prevents the worst outcome for a known gap: rediscovery-as-surprise. P3 because it changes no runtime behavior.

**Independent Test**: Read the ledger entry: it states the SIGKILL-class scope, the SIGTERM-drain deploy coverage, the order-of-a-few-events-per-year frequency, the durable-before-broadcast revisit path, and is flagged for Sam's ratification. The write/broadcast ordering in code is unchanged.

**Acceptance Scenarios**:

1. **Given** this feature is complete, **Then** the accepted-residuals ledger entry (RBD-045-5 in this feature's decisions ledger — see Assumptions for why the per-feature ledger is the home) records: (a) what remains open — durable loss of a just-broadcast edit on SIGKILL-class death (SIGKILL/OOM/native crash, drain-deadline overrun with the store down, retries-exhausted drop); (b) what already covers deploys — the SIGTERM drain; (c) estimated frequency — order of a few events per year per busy deployment; (d) that 045 closes the attribution consequence, so a residual occurrence is a durability incident, no longer a permanent attribution lie; (e) the revisit path — durable-before-broadcast, if hot-path latency ever becomes acceptable; (f) explicit flag for Sam's ratification.
2. **Given** the persistence-listener documentation of the window (the 038 FR-018 comment), **Then** it is updated to reference this feature: the display-side lie is closed, the durability residual stands, and the ledger entry is where the acceptance is recorded.
3. **Given** the loss path itself, **Then** no behavior changed: broadcast-then-commit ordering, retry policy, and drain behavior are untouched, so 043 US3's characterization of the loss path (when it lands) observes exactly the pre-045 behavior.

---

### Edge Cases

- **Relayer is also a true author in the same version**: A relays a lost edit of B's *and* makes her own edits in the same activity burst — A appears as an author (for her own rows) and B appears (resolved), with no duplication or loss of either.
- **Mixed-origin resupply row**: one `via_sync` row can carry content from multiple original clients. All resolvable origins are credited; if any content-bearing origin is unresolvable, exactly one synced-contribution entry is added for the row (not one per unknown origin).
- **Origin evidence is itself a `via_sync` row**: mapping evidence MUST come from rows whose own attribution is direct (not sync-relayed), so a chain of relays cannot launder the relayer into "evidence". A `via_sync` row never serves as attribution evidence for another row.
- **Client-identity reuse/collision**: the embedded client identity is not globally unique; if prior rows in this document associate it with more than one user, the mapping is ambiguous → unmappable (FR-006). Evidence never crosses documents.
- **Pre-existing production rows**: `via_sync` rows already in production logs get the same treatment at display time — resolution is derived from the durable log on demand; no backfill pass is required for correctness.
- **Legacy rows (`via_sync` NULL)**: entirely unaffected. NULL predates the marking or means a live edit; it is never treated as suspicious (038 contract).
- **Resupply of content whose original author's account was since deleted**: mapping resolves the client identity to a user row that no longer exists → follows the existing deleted-account Unknown-author rule, not the synced-contribution rule (the *identity* was determined; the account is gone).
- **Timeline pagination / repeated requests**: repeatedly rendering history over the same rows must not repeatedly pay the forensic decoding cost (FR-009).
- **Empty or noise-classified `via_sync` rows**: meaningfulness filtering (041's rules) applies before attribution display exactly as for any row; this feature does not change what counts as meaningful.
- **Restore/undo/diff surfaces**: untouched by design — restore attribution, undo derivation, and diffs never consult the resolution (FR-010); undo already refuses across `via_sync` rows via its own 038-era guards, which this feature must not alter.

## Requirements *(mandatory)*

### Functional Requirements

**Display truth — the core rule (US1, US2)**

- **FR-001**: No author-displaying surface may present a `via_sync` row's stamped identity as the authorship of that row's content. Covered surfaces (exhaustive for this feature): the version timeline (auto versions, named versions, and post-split fragments, per 041's range-scoped author computation), the sub-version drill-down, the per-clock author on content-at-clock views, and the current-session/recent-authors feed (including its MCP read-document consumer). (Anchors verified: `server/version-history.js` has zero `via_sync` references today — `groupUpdatesIntoVersions` at :200, `getUpdatesForVersion` at :754, `getCurrentSessionAuthors` at :815, `getContentAtClock` author at :829-861; MCP consumer `server/mcp/tools/read-document.js:141`.)
- **FR-002**: For every displayed `via_sync` row, the system MUST attempt **forensic origin resolution**: decode the persisted update's embedded original-client identifiers (the Yjs client identities its content carries) and map them to user identities using prior *directly-attributed* rows of the same document that share those client identifiers. A successful mapping recovers the true author without trusting the relayer's stamp.
- **FR-003**: A resolved origin MUST be displayed exactly as if the content had been directly authored by that identity — full author presentation (human or agent), grouped and deduplicated by the same rules as direct rows. This includes the self-relay case (the resupplying client is the original author): the 038 promise that genuine offline edits stay credited to their author is preserved with no visible difference from a live edit.
- **FR-004**: An unresolvable origin MUST be displayed as a **synced contribution**: a dedicated contributor rendering meaning "content that arrived via sync whose author is not determinable", distinct from any real user, from the relayer, and from the deleted-account Unknown-author entry [RBD-045-2]. Under no fallback does the relayer's stamped identity appear as the author.
- **FR-005**: A single `via_sync` row carrying content from multiple original clients MUST credit every resolvable origin, and MUST add exactly one synced-contribution entry if any content-bearing origin is unresolvable. Deletion-only payloads MUST NOT be attributed to anyone via their embedded identifiers (those identify deleted content's authors, not the deleter) and follow the unresolvable rendering.
- **FR-006**: Resolution MUST never guess: a client identifier associated with more than one user in the document's directly-attributed rows is ambiguous and MUST be treated as unresolvable [RBD-045-3]. Evidence MUST be drawn only from the same document, and only from rows that are not themselves sync-relayed.
- **FR-007**: Resolution MUST be deterministic and consistent: the same row yields the same resolution outcome on every surface and every request (one resolution, many renderers). Surfaces MUST NOT implement independent, divergeable resolution logic.
- **FR-008**: The rule applies to all historical `via_sync` rows at display time — including rows persisted before this feature ships — without requiring any data backfill. Rows with `via_sync` NULL or false are entirely unaffected (038 contract: NULL is never suspicious).

**Performance (US1, US3)**

- **FR-009**: Author-displaying requests MUST NOT decode every update payload on every request. Resolution for a row MUST be computed once and be reusable across subsequent requests and surfaces; the mechanism (persisted result, cache, lazy memoization) is a plan-level choice. **LOUD FLAG**: if the plan chooses a *persisted* resolution result, that is a schema migration — this spec does not require one, and the via_sync column itself already exists (`migrations/1799700000000_add-via-sync-to-yjs-updates.js`); any migration must be an explicit plan decision, not an assumption. New migrations must respect the >1795000000000 timestamp floor.

**Scope guard (all stories)**

- **FR-010**: Resolution outcomes govern DISPLAYED authorship only. They MUST NOT feed replay/reconstruction, undo derivation or its identity runs, permissions or role checks, persistence attribution (the stamped row is never rewritten), restore attribution, or diff computation. The existing 038-era `via_sync` consumers (undo's run-breaking guards, the guardrail's sync-sourced annotation) keep their current semantics.

**Guardrail detection coverage (US4)**

- **FR-011**: The collaboration guardrail's agent-content candidate selection MUST detect agent content that entered the log as a `via_sync` row through a non-agent connection. Today's selection (`agent_name IS NOT NULL`, `server/collab-guardrail.js:93` — verified) misses such rows because the resupplied row carries no agent name. Fresh `via_sync` rows whose resolved origin is an agent MUST enter the candidate set; fresh `via_sync` rows with an unresolved origin MUST be included conservatively rather than ignored [RBD-045-4]. Alert pages for sync-sourced candidates carry the existing sync-sourced annotation.
- **FR-012**: The guardrail's posture is unchanged: alert-only, never blocks or rejects an edit, and the existing directly-attributed detection path is preserved exactly (the candidate set only widens).

**Accepted residual (US5)**

- **FR-013**: The publish-before-commit durability window MUST be recorded as a first-class accepted residual, flagged for Sam's ratification, containing at minimum: scope (SIGKILL-class loss: SIGKILL/OOM/native crash, drain-deadline overrun with the store down, retries-exhausted drop), deploy mitigation (SIGTERM drain ⇒ ≈zero loss on rolling deploys), frequency estimate (order of a few events per year per busy deployment), the consequence change this feature delivers (a residual loss is a durability incident, no longer a permanent attribution lie), and the named revisit path (durable-before-broadcast, if hot-path latency ever becomes acceptable). The persistence-listener window documentation (038 FR-018 comment) MUST be updated to cross-reference this record and this feature.
- **FR-014**: This feature MUST NOT change the write/broadcast ordering, retry policy, or drain behavior of the persistence path. The loss path's observable behavior is byte-identical before and after this feature, so 043's US3 characterization remains valid.

### Key Entities

- **Sync-relayed row (`yjs_updates` with `via_sync=true`)**: a persisted update whose content reached the server through a client's sync catch-up reply. Stamped identity = channel; embedded client identifiers = origin evidence. Column and marking exist (features 038/1799700000000); this feature adds no columns by requirement.
- **Origin evidence**: the association between an embedded Yjs client identifier and a user identity, established by prior directly-attributed rows of the same document. Append-only and immutable for a given row (evidence precedes the row in clock order), which is what makes compute-once resolution sound.
- **Resolution outcome**: per sync-relayed row, the derived display answer — a set of resolved author identities and/or one unresolvable marker. Deterministic, reusable, consumed by all four display surfaces and the guardrail's candidate widening; consulted by nothing else.
- **Synced contribution**: the honest display entity for unresolvable relayed content. Distinct from a real author, from the relayer, and from the deleted-account Unknown author.
- **Guardrail candidate set**: the set of fresh rows the guardrail treats as agent content when checking human deletions; widened to cover resupplied agent content.
- **Accepted residual record**: the ledger entry (RBD-045-5) that turns the durability window from an unexamined gap into a ratifiable decision, with its revisit path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the staged loss-and-resupply matrix (relayer ≠ author; human→human, agent-content→human relay, human-content→agent relay), 0 of the four author surfaces display the relayer as author of the relayed content, and the true author is displayed on 100% of resolvable cases.
- **SC-002**: The genuine offline-edit path shows zero regression: an author re-supplying their own edits remains credited on all surfaces, indistinguishable from live editing, in 100% of covering tests.
- **SC-003**: For unresolvable cases (no evidence, ambiguous evidence, deletion-only payloads), 100% render the synced contribution; 0 render the relayer or a guessed user; the synced contribution and deleted-account Unknown author remain distinguishable.
- **SC-004**: For any staged row, the timeline, drill-down, per-clock, and recent-authors surfaces report the identical resolution outcome — 0 cross-surface disagreements in the test matrix.
- **SC-005**: A repeated timeline request over already-resolved history performs 0 per-row update-payload decodes attributable to resolution (asserted via instrumentation/spies in tests); first-render resolution cost is bounded by the rows actually displayed.
- **SC-006**: The guardrail test matrix detects 100% of human deletions of fresh resupplied agent content (resolved-agent and unresolved-conservative cases), with 0 blocked edits and 0 regressions in the direct agent-row detection tests.
- **SC-007**: The accepted-residual record exists with all six required elements and a ratification flag; the persistence-listener comment cross-references it; a diff of the loss-path behavior (ordering, retries, drain) shows zero change.

## Assumptions

- **No schema change is required by this spec.** The `via_sync` column exists (`migrations/1799700000000_add-via-sync-to-yjs-updates.js`), row payloads (`update_data`) and `via_sync` are already retrievable together (`getUpdatesInRange` with `includeData` — verified), and resolution can be computed from the durable log at read time. If the plan elects a persisted-resolution mechanism for FR-009, that migration is flagged loudly as a new decision (see FR-009), never assumed.
- **041's merged behavior is the substrate.** Range-scoped author computation (`computeRangeMeta`) and `UNKNOWN_AUTHOR` handling come from 041; this feature plugs resolution into that machinery rather than re-speccing it. Discrepancies between 041's spec and its merged code resolve in favor of the merged code, with a ledger note.
- **043 re-sequencing is owed by the orchestrator**: 043's spec text ("merges last, after 041 and 042") must be extended to "after 041, 042, and 045"; recorded as RBD-045-7. 043 US2's assertions become the end-to-end regression guard for this feature's US1 once both are merged.
- **The accepted-residuals record lives in this feature's decisions ledger** (`specs/045-resupply-attribution/clarifications-needed.md`, RBD-045-5): no repo-wide accepted-residuals ledger artifact exists today (verified by search); the per-feature ledger is the established ratification vehicle (Constitution VI), and the design amendment + the 038 FR-018 code comment are the durable cross-referencing anchors. If Sam prefers a repo-wide residuals ledger, migrating the entry is a follow-on, not a blocker. [RBD-045-5 records the residual; RBD-045-6 records this home-of-record default.]
- **All open product decisions were resolved by best default** and recorded as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** in `clarifications-needed.md` (RBD-045-1..7); none block planning. The design amendment itself is the ratified umbrella (RBD-045-1).
- **Test obligations follow Constitution Principle II**: every FR is a behavioral change (except FR-013/FR-014's documentation/no-op guarantees) and ships with tests in the affected suites; backend suites run serially against the shared DB; new integration suites follow the doc_guid-cleanup convention 043 codifies.
- **Client display work rides on server-computed authors.** The client currently has zero `via_sync` references (verified); author lists for all four surfaces are computed server-side, so honesty lands primarily in the server's computed responses, with client changes limited to rendering the synced-contribution entry.

## Verification Notes (claims re-checked 2026-08-02)

- `server/version-history.js`: zero `via_sync`/`viaSync` references in the file (grep across repo confirms it is absent from the version-history module and the entire client). `groupUpdatesIntoVersions` (:200) builds authors solely from `userId`/`agentName`; `getUpdatesForVersion` (:754) reuses it; `getCurrentSessionAuthors` (:815) reuses it; `getContentAtClock` (:829) derives its per-clock `author` from the raw row via `createAuthor` (:861). **Confirmed.**
- MCP recent-authors consumer: `server/mcp/tools/read-document.js:141` calls `getCurrentSessionAuthors`. **Confirmed.**
- Guardrail blind spot: `server/collab-guardrail.js:93` region selects candidates with `agent_name IS NOT NULL` (fresh-rows query at :89-97). **Confirmed.**
- `via_sync` exists end-to-end: migration `1799700000000_add-via-sync-to-yjs-updates.js`; INSERT includes it (`server/postgres-persistence.js:266`); `_mapUpdateRow` exposes `viaSync` with the 038 contract comment (:645-663); `getUpdatesInRange` selects `via_sync` and supports `includeData` for `update_data` (:679-713). **Confirmed.**
- 041 substrate: `computeRangeMeta` and `UNKNOWN_AUTHOR` handling present in `specs/041-version-history-truth/plan.md`/`data-model.md`; `UNKNOWN_AUTHOR` already live in `version-history.js` (040 FR-008). **Confirmed.**
- 043 interlock: `specs/043-version-history-test-hardening/spec.md` US2 scenario 2 / FR-003 assert the timeline does not credit the relaying client (RED until 045); US3/FR-004 pin the loss path as characterization tied to 038 FR-018 with no product fix. 043's sequencing line omits 045 — flagged. **Confirmed.**
- 038 FR-018: documentation-only closure of the publish-before-commit window at the persistence listener (`specs/038-attribution-integrity/spec.md:153`). **Confirmed.**
- One anchor imprecision in the investigation (immaterial): it cites the per-clock author at `getContentAtClock:861`; the function begins at :829 with the author derivation at :861. No claim falsified.
