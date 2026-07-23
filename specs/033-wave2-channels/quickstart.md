# Quickstart — Wave 2 Distribution Channels validation

**Feature**: 033-wave2-channels | **Date**: 2026-07-23

Runnable checks that prove the feature works end to end, offline, with zero side effects. Run from the
repo root inside the dev pod. Details live in `contracts/` and `data-model.md`; this is the run guide.

## Prerequisites

- Node.js 22+ (the runtime `distribution/publish.mjs` already targets).
- No network, no credentials, no `SQUIRE_MIRROR_*` env vars needed for any check below.
- Kiro IDE / Cursor app are NOT required (and not present in the pod) — real-IDE import is Sam's
  submission walk (SC-005), out of scope for these checks.

## 1. Regenerate + validate all four channels (SC-001)

```bash
node distribution/publish.mjs
```

Expected: "Regenerated 4 channel(s) (committed tree)" listing `claude-plugin`, `mcp-registry`,
`kiro-power`, `cursor-plugin`; then "✓ all bundles validate against the pinned schemas."; then the
dry-run notice (no push). Zero network, zero side effects beyond the committed bundle dirs.

## 2. Bundles are byte-stable (drift guard, SC-002)

```bash
node --test test/first-run/bundle-drift.test.mjs
```

Expected: green on a clean tree. Then verify the guard bites for the new bundles:
- Append a byte to `distribution/kiro-power/POWER.md` (or any generated file in either new bundle) →
  the test fails naming that exact file. Revert.
- Drop an extra file into `distribution/cursor-plugin/` (e.g. `touch distribution/cursor-plugin/EXTRA`)
  → the extra-file guard fails naming it. Remove.
- Rewrite ONLY the `mcp.json` url in either new bundle to `http://localhost:3052/mcp` → NOT drift
  (endpoint field exempt); rewrite any other field → drift. The committed endpoint is separately
  pinned to `https://squiredocs.com/mcp` (a dev URL can never ship).

## 3. Deeplink round-trips and is single-sourced (SC-003)

```bash
node --test test/first-run/bundle-drift.test.mjs   # includes the deeplink round-trip + cross-surface assertions
```

Expected: base64-decoding the `config` param of `cursorDeeplink()` yields exactly
`{"url":"https://squiredocs.com/mcp"}`, the `name` param is `squire-docs`, and the deeplink string on
the landing page + documentation is byte-identical to the computed value.

Manual spot check:
```bash
node -e "import('./distribution/publish.mjs').then(m=>{const u=new URL(m.cursorDeeplink());console.log(JSON.parse(Buffer.from(u.searchParams.get('config'),'base64').toString()))})"
# → { url: 'https://squiredocs.com/mcp' }
```

## 4. Publish path: fail-closed + version guard for a new channel (SC-004)

```bash
node --test test/first-run/publish-mechanism.test.mjs
```

Exercises (bare-repo fixtures only, real `SQUIRE_MIRROR_*` stripped, configured==fixture-count asserted):
- `--publish` with no env vars → refuses, naming all four `SQUIRE_MIRROR_*` vars, zero side effects.
- First publish of the Kiro (or Cursor) fixture → pushes the generated bundle.
- Content changed but the channel version unchanged between runs → refused, naming the channel's
  version carrier (POWER.md for Kiro / `.cursor-plugin/plugin.json` for Cursor).
- CLI `--publish` combined with `--out` or a non-prod `--endpoint` → exit 2 (unchanged from wave 1).

## 5. Full deterministic first-run suite + docs build (SC-006)

```bash
npm run test:first-run
npm test -- documentation-build   # or the repo's Vitest doc-build invocation
```

Expected: every pre-existing wave-1 test still passes unmodified in intent (publish-mechanism, drift,
budgets, harness, install-surfaces); the documentation build + terminology gate pass with the new
Cursor/Kiro sections present.

## 6. Site + docs surfaces (SC-007, manual read)

- `client/public/landing.html`: the "Works with your coding agent" block has an Add-to-Cursor control
  whose `href` is the exact deeplink, and a Kiro section with the repo link + the five import steps and
  NO "Add to Kiro" button.
- `documentation/agents-and-mcp.md`: per-ecosystem Cursor + Kiro sections coexist with the retained
  manual Kiro `mcp.json` snippet. Copy says "Squire Docs", honest-confident, no unearned listing claim.

## Sam-only (NOT part of these checks — handoff, spec §Sam-Only Operations)

Create the two mirror repos, first mirror push, create/alias `hello@squiredocs.com`, the
kiro.dev/powers/submit form, the Cursor marketplace submission, and the real-IDE import + DCR OAuth
walk (SC-005). None are scriptable; all are recorded in promotion notes at implement time.
