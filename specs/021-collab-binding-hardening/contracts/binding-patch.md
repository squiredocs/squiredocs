# Contract: Binding Patch (`@tiptap/y-tiptap` 3.0.7 + patch-package)

The behavioral contract for `client/patches/@tiptap+y-tiptap+3.0.7.patch`. Patched files:
`dist/y-tiptap.js` (ESM — what vite/vitest resolve via the package `exports` map) and
`dist/y-tiptap.cjs` (kept in lockstep). Every patched site carries a sentinel comment
`/* SQUIRE-021:<site-id> */` — the guard test counts them.

## Kill-switch (DR-2)

`hardeningEnabled()` ≡ `globalThis.__SQUIRE_COLLAB_HARDENING__ !== false` — read **live at
each decision point** (no caching at binding construction). When OFF, each site executes the
**verbatim stock 3.0.7 code path** — one flag, all four behaviors, atomic revert. Default is
ON (unset global ⇒ hardened). The skip-reporter hook (`globalThis.__SQUIRE_SKIP_REPORTER__`)
is independent of this flag.

## Site 1 — `SQUIRE-021:render-catch-element` (`createNodeFromYElement` catch, 3.0.7 dist ~970)

Hardened behavior, replacing the stock `el._item.delete(transaction)`:

1. **Never mutate the shared doc** (FR-001): no `transact`, no `delete`, no attribute write
   in the render direction.
2. **createAndFill first** (DR-1/Addition-2): attempt
   `schema.nodes[el.nodeName]?.createAndFill(sanitizedAttrs)`; on success the filled node
   is returned as a stand-in, recorded in `meta.mapping` AND registered as a diff-excluded
   pair (`skippedTypes` + `standIns`).
3. **Skip otherwise** (FR-002): return `null` (remainder of the document renders), register
   `el` in `skippedTypes`.
4. **Bounded logging + report** (FR-003, RBD-6, DR-3): once per element per binding
   instance, `console.error` with `{ nodeType: el.nodeName, docId, error }` and, if
   `globalThis.__SQUIRE_SKIP_REPORTER__` is set, call it fire-and-forget with
   `{ nodeType, errorName }`. Subsequent skips of the same element in the same instance are
   silent; the skip itself is unconditional.
5. Mark the binding possibly-divergent (RBD-3) so divergence resolution (site 4) applies.

## Site 2 — `SQUIRE-021:render-catch-text` (`createTextNodesFromYText` catch, 3.0.7 dist ~1005)

Same contract as site 1 applied to the text-run path (spec edge case "text-run render
failure"): no `text._item.delete`, skip the run (return `null`), bounded log + report,
register the containing element as skipped/divergent. (`createAndFill` does not apply to
text runs.)

## Site 3 — `SQUIRE-021:selection-guard` (`_typeChanged` → `restoreRelativeSelection`, 3.0.7 body)

- Selection restore is routed through a binding seam `binding._restoreRelativeSelection(tr,
  relSel, oldDoc)` (test-stubbable) and wrapped in try/catch (FR-005).
- On throw: the render transaction **still commits with all remote content**; the selection
  falls back to `TextSelection.near(tr.doc.resolve(clamp(prevHead, 0, tr.doc.content.size)))`
  — clamped to the rendered doc's valid range, correct for the empty-doc case
  (spec edge case "selection fallback bounds").
- The stale-view state (aborted render) can no longer arise from a selection throw.

## Site 4 — `SQUIRE-021:writeback-gate` (ySyncPlugin `view.update()` hook + divergence resolution)

- The PM→Y write-back (`binding.mux → _prosemirrorChanged`) runs **only when the triggering
  transaction(s) actually changed the editor doc** (FR-006): the plugin records
  `tr.docChanged` from `apply` and the update hook checks it before diffing. Selection-only,
  metadata, and other doc-unchanged transactions never write to Yjs — especially when the
  view has diverged.
- Detected divergence (any site-1/2/3 failure marks it; RBD-3 event-driven, no continuous
  auditor) resolves by scheduling `binding._forceRerender()` — re-render **from** Yjs
  (FR-007). The shared doc is unchanged by resolution; the view converges to it. Re-render
  must not loop: a re-render that again fails renders again as skip (bounded by
  `skippedTypes` — no unbounded render/failure cycling, FR-004).

## Site 5 — `SQUIRE-021:tracked-skip` (`updateYFragment`)

- `updateYFragment` receives the binding's skip registry via `meta`.
- **Invariant**: a Y child in `skippedTypes` is invisible to the diff — excluded from child
  matching, never counted toward `yDelLen`, never deleted, never "updated" toward a
  stand-in; a `standIns` view node is likewise excluded from `pChildren` (the pair drops out
  together). Front-door protection (DR-1/Addition-1): a legitimate local edit's diff leaves
  every skipped node byte-intact in Yjs.
- **Index translation**: mutation calls (`yDomFragment.delete/insert/get`) use real fragment
  indices; matching walks the filtered sequences. The patch maintains an explicit
  filtered→real index map. (The front-door test plus a multi-node neighbors test guard the
  off-by-one class.)
- When `hardeningEnabled()` is false the registry is ignored (stock diff — including its
  hazards; that is the point of the kill-switch).

## Survival guard (FR-008)

- `client/package.json`: `"@tiptap/y-tiptap": "3.0.7"` (exact) as a direct dependency;
  `"postinstall": "patch-package --error-on-fail"`; `patch-package` in devDependencies.
- Guard test `client/src/__tests__/binding-patch-guard.test.js` asserts:
  1. installed `@tiptap/y-tiptap/package.json` version `=== '3.0.7'`;
  2. `dist/y-tiptap.js` contains **exactly** the expected set of `SQUIRE-021:` sentinels
     (all five site ids present);
  3. `client/patches/@tiptap+y-tiptap+3.0.7.patch` exists.
- Consequence: a dependency bump without a rebased patch fails `npm ci` (postinstall) and/or
  this test — stock behavior can never silently return (SC-007).

## Test obligations (tests-first; all drive the harness of research R8)

| Test | Asserts |
|------|---------|
| forced throwing node (unknown nodeName from remote) | remote Y.Doc byte-identical (`Y.encodeStateAsUpdate` before/after); remainder renders; one bounded log; no rerender loop over repeated remote updates |
| createAndFill fill-before-skip | a fillable node type yields a stand-in in the view, Y untouched, pair diff-excluded |
| front-door | skipped node present in Y → legitimate local edit elsewhere → skipped node **survives in Y**, edit lands |
| selection-restore throw | render commits with all remote content; selection at clamped near position |
| divergence + doc-unchanged transaction | zero write-back, nothing deleted from Y (the incident repro) |
| divergence resolution | view converges to Y; Y unchanged |
| kill-switch OFF | stock behavior returns: the forced-throw repro **deletes** from Y again (proving genuine revert); flag back ON restores hardened behavior |
| skip report | forced skip produces exactly one reporter call per element per instance |
