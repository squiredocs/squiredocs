# Quickstart — 021-collab-binding-hardening validation

Prerequisites: repo installed (`npm ci` in `client/` — this also proves the patch applies:
postinstall runs `patch-package --error-on-fail`), backend test stack per
`docs/dev.md` / the local-backend-test-stack notes. Backend tests are **serial-only**.

## 1. Client — binding patch (US1)

```bash
cd client
npm ci                                   # must succeed; patch application is part of install
npx vitest run src/__tests__/binding-patch-guard.test.js \
  src/__tests__/binding-render-failure.test.js \
  src/__tests__/binding-selection-writeback.test.js \
  src/__tests__/binding-killswitch.test.js \
  src/__tests__/skip-reporter.test.js \
  src/__tests__/editor-quarantine.test.jsx
```

Expected: all green. The named repros (contracts/binding-patch.md test table) each assert
the shared Y.Doc's encoded state byte-for-byte; the kill-switch test proves stock deletion
returns when `globalThis.__SQUIRE_COLLAB_HARDENING__ = false` and hardened behavior when
restored.

Drift guard proof (SC-007): `cd client && npm install @tiptap/y-tiptap@3.0.6 --no-save`
⇒ postinstall fails loudly. Restore with `npm ci`.

## 2. Server — guardrail (US2)

```bash
cd server
npx jest __tests__/collab-guardrail.test.js --runInBand
```

Expected: signature fires (doc/human/agent/clock-range fields present); normal-edit and
old-agent-content controls stay silent; storm collapses to one page + suppressed count;
evaluation throw never affects persistence.

## 3. Server — gap read (US3)

```bash
cd server
npx jest __tests__/postgres-gap-read.test.js --runInBand
```

Expected: withheld-then-released `k+1` heals within the window; still-withheld serves as-is
with the gapped-serve log; gap-free path takes zero retries.

## 4. Regression + manual checks

```bash
# SC-006 — existing collaboration behavior bit-identical (run unmodified):
cd server && npx jest __tests__/attribution-bug.test.js __tests__/origin.test.js \
  ../__tests__/integration/collaboration.test.js --runInBand
cd client && npm test
```

Manual (dev pod, two browser tabs on one doc):

1. Normal typing + agent edit — sync, presence, undo, attribution unchanged.
2. Kill-switch drill: `PUT /api/admin/settings/collab-binding-hardening {"enabled":false}`
   → refresh tab → guard-test globals report stock mode; flip back ON.
3. Quarantine: load a doc containing a node type this bundle lacks with
   `enableContentCheck` active → editor goes read-only with refresh banner; the doc is
   unmodified server-side.
