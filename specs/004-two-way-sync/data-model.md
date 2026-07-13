# Data Model: Two-Way Sync (Offline-Collaborator Push)

**Feature**: 004-two-way-sync | **Date**: 2026-07-13

Most entities here are **in-memory protocol objects** (one push request's lifetime); the only
persistent-schema change is `yjs_updates.on_behalf_of` (D8). Persistent state continues to live in
the existing `yjs_updates` log — a push is stored as one ordinary update row.

## Sync Push (request-scoped)

| Field | Type | Source | Validation |
|---|---|---|---|
| `docId` | uuid | route `:docId` | must exist; acting user has editor role (002) |
| `markdown` | string | request body | 002 size cap (5 MB default); `text/markdown`/`text/plain` |
| `frontmatter` | object \| null | parsed from body (003 contract) | `squire:` block stripped from content; foreign keys preserved as content |
| `baselineClock` | int | `squire.clock`, overridden by explicit param (D3) | required; integer ≥ 0; ≤ current clock; reconstructible |
| `flavor` | `squire` \| `portable` | `squire.flavor` (default `squire`) | unknown → treated per 003 validation |
| `lossyMarks` | string[] | `squire.lossy` | mark names; unknown names ignored |
| `imageMap` | map relPath → imageId | `squire.images` | used to resolve `./assets/` refs (003) |
| `onBehalfOf` | OnBehalfOf \| null | headers/params (D6) | each field length-capped (256), plain text |
| `principal` | user identity | session / `sk_sqd_` token | `documents:write` scope; per-doc ACL re-check (FR-003) |

State transitions: `received → validated → (rejected | noop | applied)`. Rejection occurs strictly
before fork construction; `noop` strictly before any store.

## Baseline (in-memory)

Reconstructed CRDT state at `baselineClock`: `Y.Doc` from `getYDocAtClock(docId, baselineClock)`.
Derived values: `baselineStateVector` (`Y.encodeStateVector`), `baselineCanonicalMd` + `sourceMap`
(serialized in the push's flavor with lossy exclusions — R3). A pointer into version history, not a
conflict-detection token. Invariant: never mutated except via the fork's replay transaction.

## Fork / Synthetic Collaborator (in-memory)

The baseline `Y.Doc` with `clientID` pinned to `syntheticClientId(docId, baselineClock,
sha256(canonicalPushedMd))` (R4). All replayed ops land under this identity. Its
delta-since-baseline (`Y.encodeStateAsUpdate(fork, baselineStateVector)`) **is** the entire effect
of the push. Invariants: deterministic over (docId, baselineClock, canonical content) — FR-011;
clientID pinned before any op is created.

## Source Map (in-memory, serializer byproduct)

```
{
  runs:   [ { mdStart, mdEnd, textNode: Y.XmlText, textOff } ],   // sorted, non-overlapping
  blocks: [ { mdStart, mdEnd, blockIndex, blockNode: Y.XmlElement } ]
}
```

- `runs` cover exactly the characters that are document text; every other character is structure.
- `textOff` is an offset into the Y.XmlText's plain text (delta text, marks excluded).
- Invariants: `runs` within a block are in document order; assembled markdown ==
  `toMarkdownNodes(nodes)` byte-for-byte (assertion in tests); escaped chars (e.g. `\|`) split
  runs (escape char = structure, escaped char = text).

## Diff Hunk (in-memory)

```
{ oldStart, oldEnd, newText,            // baseline-md coordinates + replacement text
  kind: 'text' | 'structural',
  block: blockIndex | [startBlock, endBlock],   // resolved via sourceMap
  ops?: [ {type: insert|delete|format, ...} ]   // for text hunks (incl. mark-aware refinement)
}
```

Classification rules and prefer-text ordering: research.md R3 (implements FR-007). Invariants:
text hunks touch exactly one block and replay without deleting untouched siblings; structural
hunks expand to whole top-level block boundaries.

## Overlap Flag (response payload)

```
{ blockIndex, blockType, excerpt,                       // excerpt ≤ 80 chars, plain text
  docSide: 'edited' | 'deleted',
  pushSide: 'text' | 'structural' | 'deleted' }
```

Computed per research.md R5 (baseline-vs-live block LCS ∩ push-touched blocks). Strictly advisory
(FR-012): computed after the push is applied, never gates it.

## Push Receipt (response)

| Field | Type | Notes |
|---|---|---|
| `docId` | uuid | echo |
| `mode` | `"sync"` | echo |
| `noop` | boolean | FR-009/D7 |
| `clock` | int | new clock (content-changing) or current clock (noop) |
| `markdown` | string | canonical re-export of post-push doc, pushed flavor, refreshed frontmatter — the next baseline |
| `overlaps` | OverlapFlag[] | empty for noop |
| `operations` | `{ textHunks: int, structuralHunks: int }` | zero/zero for noop |

Error variant (rejections — FR-015, R6): `{ error, message, guidance, currentClock? }` with codes
`sync_baseline_missing`, `sync_baseline_invalid`, `sync_baseline_unavailable`,
`sync_doc_mismatch` (HTTP 400/400/410/409 respectively; the 409 is identity mismatch, not an edit
conflict).

## On-Behalf-Of Attribution (persistent — the one schema change, D8)

`yjs_updates.on_behalf_of JSONB NULL`, written only by sync pushes:

```
{ "name": "Liz Lemon", "email": "liz@example.com", "commit": "a1b2c3d", "url": "https://..." }
```

All fields optional, length-capped at write (256 chars each), rendered strictly as text in version
history (D6). Read path: `_queryUpdatesWithUsers` includes the column; timeline/version formatting
surfaces it beneath the credential's author identity. It supplements, never replaces, the token
identity — authorization and the authoritative author remain the credential's user.

## Relationships

```
SyncPush 1→1 Baseline 1→1 Fork ──(encodeStateAsUpdate)──> one yjs_updates row (+ on_behalf_of)
SyncPush 1→1 SourceMap (of Baseline)                          │
SyncPush 1→N DiffHunk ──replay──> Fork                        └─> normal path: broadcast,
SyncPush 1→N OverlapFlag (Baseline × LiveDoc × DiffHunks)          version history, search index
SyncPush 1→1 PushReceipt
```
