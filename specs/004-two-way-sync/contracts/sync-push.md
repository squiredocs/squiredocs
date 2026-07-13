# Contract: Sync Push (`mode=sync` on the import route)

**Feature**: 004-two-way-sync | **Extends**: feature 002's `PUT /api/docs/:docId/import`
(transport, auth, payload limits, image policy are 002's contract; this document defines only the
sync mode's semantics). API-first: any third-party client can implement pull/push against this.

## Request

```
PUT /api/docs/:docId/import?mode=sync[&baselineClock=<int>]
Content-Type: text/markdown          (or text/plain)
Authorization: Bearer sk_sqd_...     (or browser session)

X-Squire-On-Behalf-Of-Name:   Liz Lemon            (optional, ≤256 chars)
X-Squire-On-Behalf-Of-Email:  liz@example.com      (optional, ≤256 chars)
X-Squire-On-Behalf-Of-Commit: a1b2c3d              (optional, ≤256 chars)
X-Squire-On-Behalf-Of-Url:    https://github/...   (optional, ≤256 chars, displayed as text)

<body: the full markdown file, frontmatter included>
```

- **Auth** (FR-003): authenticated principal; scoped tokens need `documents:write`; acting user
  must hold editor role on `:docId` (re-checked every push). Errors follow 002/export-route
  conventions (401/403/404).
- **Baseline resolution** (FR-001, D3): explicit `baselineClock` param **overrides** frontmatter
  `squire.clock`; absent both → rejected (`sync_baseline_missing`).
- **Doc identity** (FR-002): if frontmatter carries `squire.docGuid`, it must equal `:docId`;
  mismatch rejected before any processing (`sync_doc_mismatch`).
- **Flavor/lossy/images** (003 contract): `squire.flavor` selects canonicalization flavor
  (default `squire`); `squire.lossy` marks are excluded from diff (FR-010); `squire.images`
  resolves `./assets/` references back to image ids.
- **Body**: untrusted input end to end — parser never-lose-content + HTML whitelist (001), image
  guardrails (002/003). Non-`squire:` frontmatter is document content per 003.

## Response — success, content-changing (200)

```json
{
  "docId": "b6edb804-cf72-416d-9c97-063a23e669c0",
  "mode": "sync",
  "noop": false,
  "clock": 1507,
  "markdown": "---\nsquire:\n  docGuid: ...\n  clock: 1507\n  flavor: portable\n  ...\n---\n\n# Doc ...",
  "overlaps": [
    {
      "blockIndex": 3,
      "blockType": "paragraph",
      "excerpt": "Retries use fixed 5s intervals with jitter.",
      "docSide": "edited",
      "pushSide": "text"
    }
  ],
  "operations": { "textHunks": 4, "structuralHunks": 1 }
}
```

- `clock` (FR-014): the stored update's clock; strictly greater than the baseline.
- `markdown` (FR-014, D7): canonical re-export of the **post-push** document in the pushed file's
  flavor with refreshed frontmatter (`clock`, `exportedAt`, `lossy`, `images`) — the client
  MUST rewrite its local file from this so it is immediately a valid next baseline. It includes
  concurrent doc-side edits present at response time. **Consistency rule**: the frontmatter
  `clock` embedded in `markdown` MUST be the clock of the exact state serialized (read atomically
  with the serialization), which is ≥ the top-level `clock` when concurrent edits landed between
  store and re-export. A file must always self-describe the state it contains — a frontmatter
  clock older than the file's content would make the next push replay concurrent edits as new
  insertions (duplicated content).
- `overlaps` (FR-012): advisory only. `docSide` ∈ `edited|deleted`; `pushSide` ∈
  `text|structural|deleted`. Never blocks/delays/alters application. Block granularity.
- `operations` (FR-014): counts of applied hunks by classification.

## Response — success, no-op (200)

```json
{
  "docId": "...", "mode": "sync", "noop": true,
  "clock": 1502,
  "markdown": "<canonical re-export of the CURRENT document>",
  "overlaps": [],
  "operations": { "textHunks": 0, "structuralHunks": 0 }
}
```

Returned when the canonical diff is empty (byte-identical push, formatting-only changes,
lossy-degradation-only changes — FR-009, US3, D7). Zero operations generated, no update stored, no
version entry. `clock` is the document's **current** clock; `markdown` re-exports current state so
the client still refreshes its local file (picking up doc-side edits).

## Response — rejections (FR-015, US5; no document mutation, no version entry, no trace)

| HTTP | `error` | When | Body extras |
|---|---|---|---|
| 400 | `sync_baseline_missing` | no `squire.clock` and no `baselineClock` param | |
| 400 | `sync_baseline_invalid` | malformed / negative / non-integer / greater than the document's current clock | `currentClock` |
| 410 | `sync_baseline_unavailable` | a clock the server can no longer reconstruct (forward guard — never occurs today; contract binds any future compaction, D1) | `currentClock` |
| 409 | `sync_doc_mismatch` | frontmatter `docGuid` ≠ route `:docId` (identity mismatch — NOT an edit conflict; the protocol has no conflict-based rejection) | |

All rejection bodies: `{ "error": "<code>", "message": "<human text>", "guidance": "Re-pull the
document (re-export) and re-apply your edits on a fresh baseline." }`. The server never degrades
to whole-document replacement (002's `mode=replace` remains the explicit opt-in for clobber).

Transport-level errors (401/403/404/413/415, unknown `mode`) follow feature 002's contract
unchanged.

## Semantics guarantees (normative)

1. **Offline-collaborator equivalence** (FR-004/FR-008/SC-002): the applied update is
   indistinguishable from a real collaborator who forked at `baselineClock`, edited, and
   reconnected. Application is order-independent w.r.t. concurrent live edits; there is no
   compare-and-set, no retry loop, no conflict state.
2. **Identity preservation** (FR-008/SC-003, Constitution IV): content not covered by a hunk is
   untouched — same CRDT items, marks, attribution, undo history. Text hunks preserve identity
   within the edited block; only structurally-replaced blocks are recreated.
3. **Determinism / idempotent retries** (FR-011, D5): identical (document, baselineClock,
   canonical content) → identical update bytes (same synthetic clientID, same ops); CRDT
   application dedupes retries — no doubled content.
4. **Single stored update** (FR-008): the push persists as exactly one `yjs_updates` row (one
   clock) through the normal path (persistence, attribution, broadcast, search indexing); it
   either lands whole or the push fails with no observable partial state.
5. **Attribution** (FR-013, D6, D8): the version entry is authored by the credential's user with
   agent-style attribution (`Repo Sync`); on-behalf-of metadata, when supplied, is stored with the
   update row and surfaced in version history strictly as length-capped plain text.
