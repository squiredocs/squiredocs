# Quickstart / Validation Guide — Word-Level Two-Tier Inline Diff Highlighting

Run everything in the Minikube `app-dev` pod (see `docs/dev.md`). Backend Jest is
serial-only (constitution II); client is Vitest under `client/`.

## Prerequisites

- No new dependencies (`diff` ^8.0.4 already installed) and no migrations.
- Shared helper `shared/diff/word-diff.js` and server helper
  `server/diff/apply-word-marks.js` implemented; schema + extension marks registered;
  CSS tokens added; `CACHE_VERSION` bumped v7→v8.

## Automated verification

```bash
# Backend (serial) — chat path, history path, cache-version characterization, round-trip
npx jest \
  server/mcp/__tests__/diff-postprocess.test.js \
  server/__tests__/diff-service.test.js \
  server/__tests__/markdown-strict-characterization.test.js \
  server/__tests__/format-roundtrip.test.js \
  --runInBand

# Client — DiffView render + fallback
cd client && npx vitest run src/components/__tests__/AiChatMessages.test.jsx
```

Expected:
- **diff-postprocess**: a word-changed `-`/`+` pair yields `inlineSegments` with the
  right changed segments keyed by output index; format-only pairs and pure add/remove
  yield none (FR-002/FR-003). See [contracts/chat-diff-payload.md](./contracts/chat-diff-payload.md).
- **diff-service**: a single-word change produces `diffDeleteWord`/`diffInsertWord` on
  only the changed word and subtle `diffDelete`/`diffInsert` on the rest; lone
  add/remove and format-only paths unchanged; a fault-injected refinement failure
  degrades to line-level marks rather than throwing (FR-007/FR-012).
- **markdown-strict-characterization**: `CACHE_VERSION === 'v8'` (FR-011).
- **format-roundtrip**: `diffInsertWord`/`diffDeleteWord` round-trip bidirectionally
  (constitution II).
- **AiChatMessages** (Vitest): `DiffView` with `inlineSegments` renders `.ai-diff-word`
  spans on exactly the changed words; a payload WITHOUT the field renders the plain line
  identically (FR-006 / SC-004).

## Manual verification (real app, both themes)

1. **Chat (US1)**: ask the in-app assistant to replace one word in an existing
   paragraph. The modify card's "Changes" diff keeps the whole `-`/`+` row tint AND
   strongly highlights only the changed word on each row (SC-001).
2. **Undo/redo (US1)**: undo that edit; its card shows the same word emphasis for free
   (020 shares the renderer).
3. **Version history (US2)**: make a one-word edit, create a version boundary, open
   Version History with "Highlight changes" on — subtle line-level insert/delete plus
   strong emphasis on only the changed word on each side (SC-002).
4. **Backward-compat (US3)**: open a chat from before the feature; its diffs render
   unchanged, no console errors (SC-004).
5. **Themes (US3)**: toggle light and every dark variant on both surfaces; the strong
   highlight stays distinguishable from the subtle tint and text stays readable (SC-007).
6. **Sanity**: a purely-added line, a purely-removed line, and a format-only change show
   row/line tint + annotations only — no word emphasis (SC-006).

## Fallback / degradation checks

- Force a refinement error (fault-injection test) → line-level output, no request/tool
  failure, no error cached (RBD-3 / FR-012).
- Oversized chat diff (> 200 lines) → `inlineSegments` keys filtered to survivors; no key
  references a truncated-away line (FR-005).
