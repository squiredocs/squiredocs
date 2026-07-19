# Research — 021-collab-binding-hardening

All decisions below were verified against the working tree on 2026-07-18/19. Design ground
truth: `design/collaboration-core.md` — the two 021 amendments (commit bcf3edc) **plus** the
newer **Addition (Sam, 2026-07-18) — 021 refined by upstream research** (commit 234858d),
which postdates the spec and is folded in here as design-ratified (ledger DR-1; the
spec↔Addition delta is resolved-by-design, not a stop-the-line finding).

---

## R1: Baseline bump 3.0.1 → 3.0.7, with per-function diff verification

**Decision**: Bump the vendored `@tiptap/y-tiptap` from 3.0.1 to **3.0.7** (exact pin as a
direct dependency in `client/package.json` so the transitive `^3.0.0` from
`@tiptap/extension-collaboration` resolves deterministically), and apply the 021 patches on
that baseline.

**Verification performed** (npm tarballs `@tiptap/y-tiptap@3.0.1` and `@3.0.7`, `dist/y-tiptap.js`):

- The vendored copy at `client/node_modules/@tiptap/y-tiptap/dist/y-tiptap.js` is
  **byte-identical** to the published 3.0.1 tarball (`diff -q` clean) — we are patching what
  npm ships, not a locally drifted file.
- Functions the 021 patch modifies, diffed 3.0.1 → 3.0.7:
  - `createNodeFromYElement` — **byte-identical** (catch-delete present in 3.0.7 at dist:970).
  - `createTextNodesFromYText` — **byte-identical** (catch-delete present in 3.0.7 at dist:1005).
  - `createNodeIfNotExists` — **byte-identical**.
  - `updateYFragment` — **byte-identical** (the front-door delete paths at 3.0.1
    dist:1342-1352 are unchanged).
  - ySyncPlugin `view.update()` hook — **byte-identical** (still no `docChanged` gate).
  - `_typeChanged` — **changed**: 3.0.7 adds `this.mapping.clear()` before the rebuild and
    passes an `oldDoc` argument to `restoreRelativeSelection`. Our guard patch wraps the
    3.0.7 body.
  - `restoreRelativeSelection` — **changed** (this is the "unrelated hardening" the Addition
    cites): 3.0.7 null-guards the node-selection anchor, adds `nodeRange` handling, and
    recovers/collapses surviving selection endpoints instead of dropping the selection. It is
    still **not** exception-guarded (`createSafeNodeRangeSelection`, `resolve`,
    `TextSelection.between` can still throw), so the 021 guard is still required — but the
    throw surface is smaller, confirming the Addition's rationale for bumping first.
- Conclusion: **all three incident hazards are retained verbatim in 3.0.7** (matching the
  design Addition's research: upstream closed the request as not-planned, issue #39), and the
  patch rebases cleanly: four of the five touched functions are byte-identical, the fifth
  (`_typeChanged`) needs its guard applied to the slightly-newer body.

**Alternatives considered**: staying on 3.0.1 (rejected: forgoes upstream's
selection-restore hardening, which directly shrinks incident path (b)'s trigger surface);
jumping to y-prosemirror directly (rejected: `@tiptap/extension-collaboration` binds to
`@tiptap/y-tiptap`'s fork lineage; swapping the underlying package is a much bigger change
than patching it).

## R2: Skipped-node protection — tracked-skip exclusion, not placeholder

The Addition mandates protection for skipped nodes (log-and-skip alone lets the next
legitimate local edit's PM→Y diff delete the skipped node "through the front door": the view
is missing the node, so `updateYFragment` sees `yChildCnt > pChildCnt` and deletes the Y
child at dist 3.0.1:1342-1352) and lets the plan choose between a **binding-generated
placeholder** (position/identity parity) and **tracked-skip exclusion in `updateYFragment`**.

**Decision**: **Tracked-skip exclusion.** The binding keeps a per-instance
`skippedTypes: Set<Y.AbstractType>` (rebuilt on every Yjs→view render pass: a failing
element is (re)added when it fails, removed when it renders — so a node that becomes
renderable rejoins the view and leaves the set). `updateYFragment` consults the set and
treats skipped Y children as invisible to the diff: they are excluded from child matching and
can never fall into the delete/replace branches. Exclusion is pair-wise: a skipped Y child
has no view counterpart, so both the child-count math and the index bookkeeping skip over
it (see "index translation" below).

**Why not the placeholder**:

1. **The placeholder can itself be written into the shared doc by the very diff we are
   hardening.** Placeholder safety depends on the identity mapping
   (`meta.mapping.set(yEl, placeholderNode)`) making `mappedIdentity()` short-circuit the
   diff. But the binding routinely clears that mapping (`_forceRerender`, `_renderSnapshot`,
   and in 3.0.7 `_typeChanged` itself calls `this.mapping.clear()`). With the mapping gone,
   `equalYTypePNode(yEl, placeholderNode)` fails and `updateYFragment`'s else-branch
   (3.0.1 dist:1332-1338) **deletes the real Y element and inserts the placeholder node into
   Yjs** — converting a display artifact into shared-content corruption, the exact failure
   class 021 exists to eliminate. Guarding that requires special-casing `updateYFragment`
   anyway, so the placeholder buys schema surface and new risk without avoiding diff changes.
2. **Schema surface**: a placeholder node type would have to be registered in the shared
   TipTap schema (`client/src/extensions/editorExtensions.js`), and Constitution Principle IV
   requires format knowledge to live in the single registry — a client-only render-artifact
   node type either drifts the shared schema or drags `server/format-registry.js` into a
   client rendering fix.
3. Tracked-skip keeps FR-001's invariant structural: a skipped element is simply invisible to
   the write-back diff, so **no** code path can delete it.

**Accepted trade-offs** (both sanctioned by US1's "degraded view" language): (a) view
positions after a skipped node are offset from Y positions by the skipped node's size, so
cursor/remote-caret placement near a skipped node can be slightly off until the node renders;
(b) the skipped node is simply absent from the view (no visible "unrenderable block" chip in
v1 — the skip-report telemetry (R9) is the observability channel instead).

**Implementation subtlety (contract-tested, see `contracts/binding-patch.md`)**: inside
`updateYFragment`, deletes/inserts use **real fragment indices** (`yDomFragment.delete(left,
…)`) while matching walks a **filtered view** of `yChildren`. The patch must translate
filtered indices back to real indices when mutating (or equivalently, advance `left` past
skipped children without counting them in `pChildren` terms). The front-door test exists
precisely to catch an off-by-one here.

**createAndFill first (Addition refinement 2)**: before skipping, the render catch attempts
`schema.nodes[el.nodeName]?.createAndFill(sanitizedAttrs)` (upstream v2's approach). If it
succeeds, the filled node stands in for the unrenderable content **and the element is still
recorded in `skippedTypes`** (its view stand-in does not reflect Y content, so it must be
just as invisible to the PM→Y diff as a pure skip — otherwise the diff would "correct" the
real Y children toward the filled node's empty content). The stand-in is additionally
recorded (mapping + a `standIns` map) so the pair (Y child, stand-in view node) is excluded
from the diff together. If `createAndFill` returns null or throws, pure skip.

## R3: Patch delivery mechanism — patch-package, not a vendored fork

**Decision**: **patch-package**, added as a `devDependency` of `client/` with
`"postinstall": "patch-package --error-on-fail"`, patch file committed at
`client/patches/@tiptap+y-tiptap+3.0.7.patch` (covering `dist/y-tiptap.js` and
`dist/y-tiptap.cjs`; sourcemaps left stale — acceptable, noted in the patch header).

**Repo facts driving the choice**: `client/node_modules` is **git-ignored** (verified
`git check-ignore` — the "vendored" copy is just the npm-installed one), the client builds
with vite + npm (`client/package-lock.json` present), and there is **no existing
patch-package or `overrides` precedent** in `client/package.json` or the root
`package.json`. So the fix must survive a clean `npm ci` in CI/worktrees purely from
committed files — which is exactly patch-package's contract (postinstall re-applies;
`--error-on-fail` makes a failed application kill the install loudly).

**Alternatives considered**:

- *Vendored fork under `client/src` + vite/vitest alias*: rejected — `@tiptap/extension-collaboration`
  imports `@tiptap/y-tiptap` internally, so the alias must be duplicated across vite AND
  vitest resolution, and anything that resolves the real package (a future tool, a script)
  silently gets stock behavior; two resolution systems is exactly the kind of quiet drift
  FR-008 forbids.
- *npm `overrides` → `file:` tarball fork committed in-repo*: workable but makes every future
  upstream bump a manual re-fork; patch-package keeps the delta reviewable as a diff and
  fails loudly on version drift.

**FR-008 drift guard** (belt to patch-package's braces): a vitest guard test
(`client/src/__tests__/binding-patch-guard.test.js`) asserts (a) the installed
`@tiptap/y-tiptap/package.json` version is exactly `3.0.7`, (b) each of the four patch sites
in the installed `dist/y-tiptap.js` carries its `SQUIRE-021` sentinel marker (exact count),
and (c) the patch file for `3.0.7` exists in `client/patches/`. A routine dependency bump
either fails postinstall (`--error-on-fail`) or fails this test — it cannot silently
resurrect the incident.

## R4: Runtime kill-switch — `app_settings` key + `/api/client-config`, live-read global

Requirement (Sam risk review, ledger DR-2): a single server-delivered flag reverts all four
patched behaviors to stock without rebuild/redeploy; default ON; at most a page refresh to
take effect; guardrail unaffected; quarantine layer independent.

**Decision**:

- **Server**: new `app_settings` key `collab_binding_hardening` (the existing admin-editable
  key/value store, `server/api/app-settings.js`, in-memory cached — the app's runtime-config
  channel; the `app_settings` table already exists, so **no migration**). Absent/`'true'` =
  ON; `'false'` = OFF. Admin GET/PUT at `/api/admin/settings/collab-binding-hardening`
  following the existing `shared-model` pattern in `server/api/admin.js` (PUT writes through
  `setSetting`, which keeps the cache coherent — flip is effective immediately, no restart).
- **Delivery**: new `GET /api/client-config` (requireAuth, in `server/index.js`) returning
  `{ collabBindingHardening: boolean }` read via `appSettings.getSetting`.
- **Client**: fetched once at app bootstrap (small hook `client/src/hooks/useClientConfig.js`
  using the AuthContext axios instance), stored on
  `globalThis.__SQUIRE_COLLAB_HARDENING__`. **Default ON**: the patched code treats any value
  other than the explicit boolean `false` as ON, so a failed/slow config fetch, a test
  environment, or a stock page all run hardened.
- **Patch integration**: each patched decision point calls a tiny inline
  `hardeningEnabled()` (`globalThis.__SQUIRE_COLLAB_HARDENING__ !== false`) and falls back to
  the **verbatim stock code path** when OFF — an atomic, all-four revert, no per-behavior
  mixing. Reading the global **live at each decision point** means a flip propagates to open
  tabs on their next render/edit; "at most a page refresh" is the guarantee, live pickup is
  the bonus. It also gives tests a trivial toggle (the flag-off incident repro asserts stock
  deletion returns, proving the switch genuinely reverts).
- **Independence**: the server guardrail (R6) and the quarantine layer (R5) do not read this
  flag.

**Alternatives considered**: env var on the server (rejected: flipping requires a
redeploy/restart — the requirement is instant revert); a per-user flag (rejected: v1 is a
global operational kill-switch, not an experiment framework).

## R5: Second defense layer — TipTap `enableContentCheck` + quarantine

**Decision**: enable TipTap's content checking on the collaborative editor
(`client/src/components/Editor.jsx` `useEditor` options: `enableContentCheck: true`,
`onContentError`) — verified available in the installed `@tiptap/core` (3.15,
`dist/index.d.ts:1375,1405`). On `contentError` the handler applies the documented
schema-outdated-client quarantine: call the event's `disableCollaboration()`, set
`emitUpdate: false` semantics by immediately calling `editor.setEditable(false)` (no further
local transactions reach Yjs), and surface a "This document uses features this page version
can't display — refresh to update" banner via the existing EditorView banner surface.
Quarantine is **independent of the kill-switch** (R4) and fires for whole-doc schema
mismatch (the class the binding patch's per-node skip is deliberately not for). The editor
recreation path (`Editor.jsx:124`, `[isMobile, provider]` deps) recreates the options object
each time, so every binding instance carries the check — no stock-window across recreation.

**Alternatives considered**: quarantine by destroying the provider (rejected — heavier, and
losing awareness/presence makes recovery messier than read-only + refresh prompt).

## R6: Server guardrail — Yjs update introspection, off the write path

**Decision** (per RBD-1/2/4 and spec FR-009..012): new module `server/collab-guardrail.js`,
invoked fire-and-forget from the bindState persistence listener in `server/index.js`
(~:247-299) **after** `storeUpdate`'s promise resolves (so evaluation can never precede or
outlive-block persistence; an evaluation error is caught, logged, and swallowed — it shares
the listener's `notifyException` idiom only for its own alert, never for flow control).

**Matching algorithm** (verified feasible against installed server `yjs` — `Y.decodeUpdate`
exists and returns `{ structs, ds }`):

1. Trigger only for **human-attributed** updates: `parseOrigin(origin)` yields
   `userId && !agentName` (`server/origin.js`; browser sockets are stamped
   `ws.userId`/`ws.agentName` at `server/index.js:1777-1778`). Agent-deletes-agent is
   excluded by design (RBD-2).
2. `Y.decodeUpdate(update).ds` → the update's delete set: `Map<clientID, {clock, len}[]>`
   of **Yjs item ID ranges** (NOT `yjs_updates.clock` values — the two clock spaces must
   never be conflated). Empty delete set → done (the overwhelmingly common case, zero DB
   work).
3. Otherwise query recent agent rows for the doc:
   `SELECT clock, agent_name, user_id, created_at, update_data FROM yjs_updates WHERE
   doc_guid = $1 AND agent_name IS NOT NULL AND created_at > now() - ($2 * interval '1
   second') ORDER BY clock` (N = freshness window, default 10s, env
   `GUARDRAIL_FRESHNESS_SECONDS`). Index support: `yjs_updates` PK `(doc_guid, clock)`
   bounds the scan to one doc; the recency predicate keeps the row count tiny.
4. For each agent row, `Y.decodeUpdate(row.update_data).structs` yields the inserted item ID
   ranges (`id.client`, `id.clock`, `length`); intersect with the human update's delete-set
   ranges. Any overlap → match.
5. On match: `notifyException(new Error('Human-attributed deletion of fresh agent
   content'), { source: 'collab-guardrail', extra: { docGuid, humanUserId, agentName,
   agentClockRange: [minClock, maxClock], overlappedItemRanges, suppressedSinceLastAlert } })`
   — document, human user, agent identity, affected clock range (FR-010).
6. **Suppression** (RBD-1): in-memory `Map` keyed `${docGuid}:${userId}`; after an alert,
   further matches for that pair within `GUARDRAIL_SUPPRESSION_MS` (default 5 min) increment
   a counter instead of paging; the next fired alert carries the suppressed count.

**Alternatives considered**: synchronous evaluation before broadcast (rejected — RBD-4:
the write path is the hottest correctness-critical path; "never blocks" is strongest when the
guardrail *cannot* block); persisting suppression state (rejected — a restart forgetting
suppression at worst re-pages once, acceptable for v1 and keeps it stateless).

## R7: getYDoc gap tolerance

**Decision** (per RBD-5): in `server/postgres-persistence.js` `getYDoc` (:211-235):

- The row query must additionally select `clock` (today it selects only `update_data` —
  gap detection is impossible without it).
- **Detection**: single pass over the already-fetched, clock-ordered rows — a gap is
  `rows[i].clock !== rows[i-1].clock + 1`. Contiguity is judged **within** the fetched rows
  (no assumption about the first clock value — head-of-history edge case). Empty/single-row
  results are trivially gap-free.
- **Retry**: on gap, up to `COLLAB_READ_GAP_RETRIES` (default **2**) full re-fetches after
  waits of `COLLAB_READ_GAP_RETRY_DELAYS_MS` (default **"100,300"**) — total added latency
  bounded ≈500 ms regardless of gap count (the budget never compounds per-gap). First
  gap-free fetch wins immediately.
- **Serve-as-is**: still gapped after the budget → build and return from the rows we have
  (never an error, never a hang — today's behavior for the pathological case) and log a
  structured line (`[Postgres] getYDoc <guid>: served with clock gap after N retries …`) so
  the gapped serve is observable (FR-015).
- **Hot path**: gap-free reads take the exact current code path plus one integer-compare
  pass over rows already in memory (FR-016). This single choke point covers every log-rebuild
  reader — version history, diffs, exports, MCP `read_document`, and `getDiff`/bindState —
  verified: they all funnel through `getYDoc` on `postgres-persistence.js`.

**Alternatives considered**: incremental fetch of just the missing clocks (rejected —
RBD-5 pins full re-fetch for trivial correctness); blocking until the gap heals (rejected
by FR-015 — a crashed writer would wedge every read).

## R8: Client test strategy — headless binding harness, not a mounted React editor

**Facts**: client tests are vitest + jsdom (`client/vite.config.js` test block); the existing
`Editor.test.jsx` **mocks TipTap entirely** (`vi.mock('@tiptap/react')`), so no existing test
exercises the real binding; y-prosemirror's own suite is the reference pattern for driving
the real plugin in jsdom.

**Decision**: a dedicated harness (`client/src/test/bindingHarness.js`) that builds, without
React/TipTap-react:

- two `Y.Doc`s ("local" and "remote") wired by relaying `Y.applyUpdate` both ways,
- an `EditorState` using the app schema derived from `getBaseExtensions()` (schema parity
  with production) plus `ySyncPlugin(localFragment)` from the **patched** `@tiptap/y-tiptap`,
- a real `prosemirror-view` `EditorView` mounted on a jsdom element with a `dispatch` that
  applies state and records transactions.

Failure injection, per repro:

- *Render failure*: the remote doc inserts an element with a `nodeName` absent from the
  local schema — `schema.node()` throws naturally (this is also the realistic mixed-version
  trigger). No monkey-patching needed.
- *Selection-restore throw*: the patch routes restore through a binding seam
  (`binding._restoreRelativeSelection(...)` — a deliberate, documented patch addition) that
  tests stub to throw. This keeps the repro honest (the guard catches a real throw in the
  real call site) without depending on jsdom quirks to produce one.
- *Divergence + doc-unchanged transaction*: force a stale view (via the aborted-render path
  with the guard test-disabled, or by dispatching a no-op `tr.setMeta` transaction after a
  suppressed render), then dispatch a selection-only transaction and assert zero Y mutation.
- *Byte-identity*: `Y.encodeStateAsUpdate(remoteDoc)` compared byte-for-byte before/after on
  the doc that must not change.

**Fallback** (noted for the implementer): if `EditorView` proves too jsdom-hostile for a
specific repro, the harness may drive `ProsemirrorBinding` with a minimal view shim
(`{ state, dispatch, hasFocus: () => false }`) — the assertions are all on Y.Doc bytes and
`EditorState`, not on DOM rendering.

## R9: Skip-event observability — minimal authenticated beacon (no client o11y channel exists)

**Facts verified**: feature 014 (app instrumentation) explicitly scoped **out**
frontend/browser instrumentation (`specs/014-app-instrumentation/spec.md:179`); grep of
`client/src` finds no telemetry/beacon/error-reporting channel. Per the DR-3 requirement
("ride the existing path; if none exists client-side, a minimal beacon endpoint is
acceptable"), we add the minimal endpoint.

**Decision**:

- **Client**: `client/src/utils/skipReporter.js` — collects skip/stand-in events
  `{ nodeType, errorName, count }` per document, deduplicated by the same once-per-element
  rule as console logging (RBD-6), debounced (2 s) and batched into a single fire-and-forget
  `POST /api/collab/render-skip-report` via the AuthContext axios instance (cookie/token
  auth already attached). Failures are swallowed; reporting can never affect editing. The
  reporter is wired into the patched binding's skip path via a global hook
  (`globalThis.__SQUIRE_SKIP_REPORTER__`, set at app bootstrap) so the patch has no import
  edges into app code. Reporting is **not** gated by the kill-switch (when the switch is
  OFF, stock behavior produces no skip events — but the channel itself stays live).
- **Server**: `POST /api/collab/render-skip-report` (requireAuth, JSON body ≤ 8 KB,
  shape-validated, content-free by construction — node type names and error class names
  only, never document text). Handler emits a structured log line and increments an OTel
  counter `collab.render_skip.reports` (attributes: nodeType, errorName) through the
  feature-014 metrics spine (`server/telemetry/metrics.js`) — that stack already alerts, so
  "know within minutes" rides existing o11y. Untrusted-input boundary per Constitution V:
  auth required, size-capped, schema-validated, rate-limited via the existing
  `server/rate-limit.js` limiter classes.

**Alternatives considered**: reusing `notifyException` email per skip (rejected — skips are
expected-rare but bursty across many viewers; email is the wrong channel and RBD-6's
bounding is per-client, not global); full browser OTel SDK (rejected — 014 scoped it out;
a beacon is proportionate).
