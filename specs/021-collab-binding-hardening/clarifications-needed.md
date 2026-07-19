# Clarifications Ledger — 021-collab-binding-hardening

Decisions the design amendments (`design/collaboration-core.md` — **Amendment (Sam,
2026-07-18) — the editor binding must never destroy remote content (feature 021)** and
**Amendment (Sam, 2026-07-18) — reads tolerate clock gaps (feature 021)**, commit bcf3edc)
did not answer were taken with the best default and recorded here as
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)**.

Decisions the amendments already made are Sam-ratified 2026-07-18 and are cited in the spec,
not re-decided: the four binding-fix behaviors (log-and-skip instead of delete-on-render-catch;
guarded selection restore with a safe near-fallback; editor→Yjs diff gated on the transaction
changing the doc; divergence resolved by re-rendering FROM Yjs); the guardrail's shape
(exception-notifier alert on a human-attributed delete of seconds-old agent content, detection
only); getYDoc gap detection + brief retry + serve-as-is; recovery deferred to feature 016.

The patch-vs-vendored-fork delivery choice for the binding fix is explicitly a **plan-phase
decision** per the task pin — the spec fixes the behaviors and the survival guard (FR-008),
not the mechanism.

---

## DR-1: Design Addition (234858d) folded in as design-ratified

- **Status**: DESIGN-RATIFIED (Sam, 2026-07-18 — `design/collaboration-core.md`,
  **Addition — 021 refined by upstream research**, commit 234858d; postdates the spec)
- **Delta vs. spec**: the Addition refines the fix contract beyond the amendments the spec
  cites: (1) skipped-node protection (log-and-skip alone leaves a front door: the next
  legitimate local edit's PM→Y diff deletes the skipped node) via placeholder OR
  tracked-skip — **plan chose tracked-skip exclusion** (research R2: placeholders can be
  written into Yjs by the diff whenever the identity mapping is cleared, and would add a
  schema-registry surface); (2) createAndFill-style filling attempted before skipping;
  (3) baseline bump of the vendored binding 3.0.1 → 3.0.7 FIRST, patches on that baseline
  (per-function diff verification in research R1: the patched functions are byte-identical
  across versions except upstream's own selection-restore hardening); (4) TipTap
  `enableContentCheck`/`onContentError` + disable-collaboration quarantine as a second
  layer; (5) upstream filing (y-tiptap issue + y-prosemirror #39/#258) recorded as an owed
  follow-up in the plan's Promotion Notes, not a feature task.
- **Handling**: design wins over the older spec text; folded into plan/contracts/tasks as
  ratified design, analyze notes the spec↔Addition delta as resolved-by-design (not a
  stop-the-line finding).

## DR-2: Runtime kill-switch for the binding patch

- **Status**: DESIGN-RATIFIED (Sam risk review, relayed 2026-07-19)
- **Decision**: the binding patch ships with a runtime kill-switch reverting all four
  patched behaviors to stock without rebuild/redeploy. One flag, atomic revert (no
  per-behavior mixing in v1); default ON; at most a page refresh to take effect. Channel:
  the existing admin-editable `app_settings` store (key `collab_binding_hardening`) served
  to the client via a new authenticated `GET /api/client-config`, applied as a live-read
  global with fail-safe default ON (research R4). A test proves stock behavior returns
  under flag-off (the incident repro deletes again), i.e. the switch genuinely reverts.
  The server guardrail stays active regardless of the flag; the quarantine layer
  (enableContentCheck) is independent of it.
- **Rationale** (Sam): the combined patch is first-of-its-kind in y-prosemirror's sync
  path; prod needs an instant revert that isn't a deploy rollback.

## DR-3: Render-skip events are observable server-side

- **Status**: DESIGN-RATIFIED (Sam divergence review, relayed 2026-07-19)
- **Decision**: skip/stand-in events are reported to the server, not just console-logged.
  Verified there is no existing client→server telemetry path (feature 014 explicitly
  scoped out browser instrumentation), so per the pre-authorized fallback a minimal
  authenticated beacon is added: `POST /api/collab/render-skip-report` (doc id, node type,
  error class, binding version, count; content-free), batched/debounced client-side under
  the RBD-6 once-per-element rule, fire-and-forget, active regardless of kill-switch
  state; server emits a structured log + OTel counter on the feature-014 metrics spine.
  Test: a forced skip produces exactly one report (contract:
  runtime-config-and-skip-report.md).
- **Rationale** (Sam): divergence classes 2/3 (invalid composites, mixed-version clients)
  are expected-rare — the point is to KNOW within minutes if they occur in prod; same
  silence-is-not-acceptable philosophy as the deletion guardrail.

## RBD-1: Guardrail defaults — 10-second freshness window, per-(doc,user) alert suppression

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment says "within the last few seconds" and pins nothing about
  storm behavior. What is the freshness window default, and what does rate-limiting look
  like?
- **Decision**: Freshness window N defaults to **10 seconds**, environment-tunable
  (spec FR-009). Rate limiting: after an alert fires for a given (document, human user)
  pair, further matches for that pair within a suppression window (default **5 minutes**,
  environment-tunable) are counted, not paged; the count of suppressed occurrences is
  carried on the next alert that does fire (spec FR-012). Different documents or different
  humans alert independently.
- **Why this default**: 10s comfortably covers the incident's timing (render-failure and
  stale-view write-backs fire within moments of the remote content arriving) while keeping
  deliberate human "reject the agent's edit" actions older than the window out of scope in
  most flows. Keying suppression by (doc, user) matches how an incident actually manifests
  (one viewer's tab misbehaving against one doc) so a single storm collapses to one page
  without masking a second, unrelated incident.

## RBD-2: Guardrail scope — human-attributed deleters only

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: Should the guardrail also alert when an *agent*-attributed update deletes
  another agent's fresh content?
- **Decision**: No. The guardrail matches only updates attributed to a human (a row with a
  user identity and no agent identity) whose delete set covers fresh agent-created content.
  Agent-deletes-agent is normal collaborative behavior (agents legitimately rewrite each
  other's and their own recent output constantly) and would drown the signal.
- **Why this default**: The incident's defining signature — what makes it forensically
  distinguishable from every legitimate operation — is the *viewer* attribution: a human
  identity destroying seconds-old agent content it plausibly never even rendered. That is
  the class the amendment names ("attribute the deletion to the WATCHING viewer").

## RBD-3: Divergence detection is event-driven in v1, not a continuous auditor

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: FR-007 says *detected* divergence resolves by re-rendering from Yjs — but
  the amendment does not say how divergence is detected. Does v1 include a continuous
  view/Yjs comparison?
- **Decision**: Detection is event-driven: the binding's own failure paths (a skipped
  render, a selection-restore fallback, any caught error in the Yjs→view direction) mark
  the view as possibly-divergent and schedule a re-render from the shared doc. No
  background or per-transaction integrity comparison of view vs. shared doc is added in
  v1 (spec Out of Scope). With FR-006 in place (no write-back without docChanged), an
  undetected stale view can no longer damage the shared doc — it can only under-display
  until the next remote update re-renders it.
- **Why this default**: A continuous checksum/compare on every transaction is a hot-path
  perf hazard on large docs and is not needed for safety once the write-back is gated;
  the failure paths are exactly the places divergence is created, so hooking them covers
  the incident class. A continuous auditor can be a follow-up if skipped-node telemetry
  ever shows undetected divergence.

## RBD-4: Guardrail evaluation runs off the write path, best-effort

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment pins that the guardrail alerts and never blocks, but not
  where evaluation sits relative to update persistence/broadcast.
- **Decision**: Evaluation is asynchronous relative to the update's persistence and
  broadcast — it may lag by up to a few seconds and MUST NOT add latency to, or be able to
  fail, the store/broadcast path (an evaluation error is logged and swallowed; spec
  FR-011). Detection latency of seconds is acceptable; the alert is for the operator, not
  for the clients.
- **Why this default**: The write path is the product's hottest, most correctness-critical
  path (terminal persistence failure already pages as data-loss risk); coupling a new
  analysis step into it would add a new failure mode to prevent a purely-observational
  feature from lagging. "Never blocks" is strongest when the guardrail *cannot* block.

## RBD-5: getYDoc retry defaults — up to 2 re-reads within ~500 ms, full re-fetch

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment says "briefly retries the read before returning" — how many
  retries, how long, and does a retry re-query everything?
- **Decision**: On a detected gap: up to **2** retries with short waits (on the order of
  100 ms then 300 ms — total added latency bounded at roughly **500 ms**), each retry
  re-running the full row fetch; both the retry count and the wait budget are
  environment-tunable (spec FR-014). First gap-free fetch wins immediately. Still gapped
  after the budget → serve as-is and log (spec FR-015). Gap-free first reads take zero
  retries and zero waits (spec FR-016).
- **Why this default**: The race being healed is a mid-commit row — commit latency is
  milliseconds, so sub-second cover is generous; the observed incident self-healed on the
  literal next read. Bounding at ~500 ms keeps the worst case (writer crashed pre-commit,
  gap never heals) from turning every subsequent read of that doc into a slow read, while
  a full re-fetch keeps the logic trivially correct (no incremental merge bookkeeping).

## RBD-6: Render-failure log bounding — once per failing element per binding instance

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: FR-003 requires debuggable logging and FR-004 forbids flood/loops, but the
  amendment does not define the bounding granularity for a persistently-failing element.
- **Decision**: The binding logs a given failing element's error **once per binding
  instance** (i.e. again after an editor recreation, which is when the environment that
  caused the failure may have changed), with element/node type, document identity, and the
  error; subsequent skips of the same element in the same instance are silent. The skip
  itself stays unconditional — bounding applies to logging, never to the log-and-skip
  safety behavior.
- **Why this default**: Remote updates can arrive per-keystroke; per-occurrence logging of
  a permanently-bad node would flood the console into uselessness (its own kind of
  unusable client, which US1 scenario 5 forbids) while adding no new information. One
  entry per instance preserves exactly the debugging signal FR-003 wants.
