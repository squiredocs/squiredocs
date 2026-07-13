# Feature Specification: Two-Way Sync (Offline-Collaborator Push)

**Feature Branch**: `004-two-way-sync`

**Created**: 2026-07-13

**Status**: Draft

**Input**: Design ground truth: `design/markdown-import-two-way-sync.md` §2.4 and §2.4.1 (M4 milestone), with `design/collaboration-core.md` (clock semantics, update log, version history) and `design/agent-surface-mcp.md` (credentials, attribution, REST export).

## Overview

Squire documents exported to a Git repository (feature 003) carry frontmatter naming the document and the version clock they were exported at. Today edits made to that repo file cannot flow back — the repo copy is a dead end. This feature adds the **push half of the sync protocol**: a repo file, edited by humans or tooling (e.g. spec-kit), is pushed back to Squire and its edits are replayed as **native CRDT operations anchored at the export-time baseline**, exactly as if the repo editor were a collaborator who went offline at that clock, made the edits, and reconnected. CRDT convergence merges the pushed edits with everything that happened in the live document meanwhile — deterministically, with no conflict states, no blocking, and no resolution interface. Concurrently-changed blocks are reported as **advisory overlap flags** for after-the-fact review in version history.

This is the mechanism that lets design docs authored collaboratively in Squire round-trip through a repo (and spec-kit runs) without destroying collaboration, undo history, version attribution, or CRDT identity — the product invariants of Constitution Principle IV.

## Dependencies (consumed contracts)

- **Feature 001 (general parser)**: tolerant CommonMark+GFM parsing with the never-lose-content rule and the HTML whitelist; canonicalization of pushed markdown rides on it.
- **Feature 002 (import surfaces)**: the authenticated `PUT` import route on an existing document and the `documents:write` token scope. This feature adds a sync mode to that route; transport, auth plumbing, payload limits, and external-image policy are 002's contract.
- **Feature 003 (portable export & frontmatter)**: the `squire:` frontmatter block (`docGuid`, `clock`, `flavor`, `lossy`, image mapping), portable flavor degradations, and task-list schema. Pushed files carry 003's frontmatter; the response re-export uses 003's serializer.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Push repo edits into a live document (Priority: P1)

A design document lives in Squire and was exported (with frontmatter) into a Git repo. A spec-kit run — or a human with a text editor — edits the repo file: rewrites a sentence, checks a task item, adds a new section. The sync tooling pushes the file back to Squire. The document updates with exactly those edits, the file on disk is rewritten from the response so it is immediately a valid next baseline, and the change shows up in version history attributed to the pusher.

**Why this priority**: This is the entire feature — the write half of the round trip. Without it there is no two-way sync; everything else (overlap flags, attribution metadata, no-op detection) qualifies this flow.

**Independent Test**: Export a document with frontmatter, edit the markdown text, push it back via the sync mode of the import route, and verify the live document contains the edit, the response carries the new clock and a canonical re-export, and version history shows a new entry by the pushing identity.

**Acceptance Scenarios**:

1. **Given** a document exported at clock N with frontmatter, **When** the file is pushed back with a single sentence changed inside one paragraph, **Then** the live document reflects the changed sentence, all other content is untouched (byte-identical text and formatting elsewhere), and the response returns a clock greater than N plus a canonical re-export of the post-push document.
2. **Given** a pushed file whose edit adds a new heading and paragraph between existing blocks, **When** the push completes, **Then** the new blocks appear at the corresponding position in the live document and surrounding blocks retain their identity (undo history and attribution of untouched blocks are unaffected).
3. **Given** a pushed file that deletes a block present in the baseline, **When** the push completes, **Then** the block is removed from the live document and the deletion is recoverable through version history like any other edit.
4. **Given** connected live editors viewing the document, **When** a push lands, **Then** they see the pushed edits appear in real time through the normal update path (no reload, no special state).

---

### User Story 2 - Concurrent edits converge without conflicts (Priority: P1)

While the repo file was being edited, collaborators kept editing the live document. The push still succeeds — no conflict error, no retry, no lock. Both edit streams appear in the final document, interleaved exactly as two live collaborators' edits would be. Blocks that changed on both sides since the baseline are listed in the push response as advisory overlap flags so the pusher (or a CI annotation) knows which blocks deserve a human glance in version history.

**Why this priority**: The offline-collaborator model is the design's core claim and the reason no conflict-resolution interface exists. If concurrent edits blocked or clobbered each other, the feature would be worse than useless for a collaborative product.

**Independent Test**: Export at clock N, edit block A in the live document, edit block B in the repo file, push. Both edits present, no overlap flagged. Repeat with both sides editing block A: both edits present (character-interleaved), block A flagged as overlap.

**Acceptance Scenarios**:

1. **Given** a baseline at clock N, **When** the live document gains an edit in block A and the pushed file edits block B, **Then** both edits appear in the final document and the response reports no overlaps.
2. **Given** both sides edit different character spans of the same block, **When** the push lands, **Then** both edits apply (no whole-block clobber) and the block is flagged as an overlap.
3. **Given** both sides rewrite the same span, **When** the push lands, **Then** the characters interleave per CRDT semantics (possibly reading oddly), the block is flagged as an overlap, and version history provides the review/recovery surface.
4. **Given** a pushed structural change to a block (e.g. paragraph became a list) while a live editor typed inside that block, **Then** the structural replacement wins, the doc-side edit is dropped with the replaced node, and the block is flagged as an overlap.
5. **Given** live edits arriving *during* the push processing window, **When** the push's update is applied, **Then** the result is identical regardless of arrival order (order-independent; no compare-and-set, no retry loop, no failure mode caused by concurrent editing).

---

### User Story 3 - Formatting-only and unchanged pushes are true no-ops (Priority: P2)

A repo tool reflows lines, normalizes `*bold*` to `**bold**`, or pushes a file that was never edited. Nothing happens: the push produces zero operations, stores no update, and creates no version-history entry. The response still returns the current clock and canonical re-export so the local file can be refreshed.

**Why this priority**: Without canonicalization-based no-op detection, every pull/push cycle would generate phantom edits, polluting version history and attribution — the round-trip invariant is what keeps the protocol honest.

**Independent Test**: Export a document, reformat the markdown without changing content (emphasis delimiters, line reflow), push, and verify the document's clock is unchanged and no version entry was created.

**Acceptance Scenarios**:

1. **Given** an exported file pushed back byte-identical, **When** the push completes, **Then** zero operations are generated, no update is stored, no version entry appears, and the response indicates a no-op with the current clock.
2. **Given** an exported file whose only changes are markdown-formatting equivalences (delimiter style, whitespace reflow that canonicalizes away), **When** pushed, **Then** the outcome is identical to scenario 1.
3. **Given** a portable-flavor file whose frontmatter lists lossy marks (e.g. underline degraded on export), **When** pushed with no content edits, **Then** the lossy degradation does not register as an edit — the live document's underline/color marks survive intact.

---

### User Story 4 - Pushes are attributed, with on-behalf-of provenance (Priority: P2)

Pushes authenticate with an API token. The resulting version-history entry shows the token's identity as the author — like any agent edit — and may additionally carry on-behalf-of metadata (git commit author, commit sha) supplied by the sync tooling, so a push originating from a teammate's commit is traceable to that commit and person.

**Why this priority**: Provenance is a product invariant (Constitution IV); agent/tool output entering a document must stay attributable. Required before anyone runs this from CI.

**Independent Test**: Push with a token plus on-behalf-of metadata; inspect version history and confirm the entry is attributed to the token identity and surfaces the on-behalf-of details.

**Acceptance Scenarios**:

1. **Given** a content-changing push authenticated by an API token, **When** it lands, **Then** version history shows a normal version entry authored by the token's user identity (agent-style attribution), indistinguishable in mechanism from other agent edits.
2. **Given** on-behalf-of metadata (author name/email, commit identifier) supplied with the push, **When** the version entry is viewed, **Then** that metadata is visible alongside the entry, rendered strictly as text.
3. **Given** a push without on-behalf-of metadata, **Then** attribution falls back to the token identity alone.

---

### User Story 5 - Stale or invalid baselines are rejected with re-pull guidance (Priority: P3)

A repo file's frontmatter clock cannot be used as a baseline — it is malformed, refers to a state the server cannot reconstruct, or points past the document's history. The push is rejected outright with an error that tells the tooling to re-pull (re-export) and re-apply its edits on a fresh baseline. The live document is never touched by a failed push.

**Why this priority**: Today every historical clock is reconstructible (the full update log is retained, no compaction exists), so this path is a forward guard — but the protocol contract must exist before any future compaction/retention policy does, and malformed input handling is needed on day one.

**Independent Test**: Push with a frontmatter clock greater than the document's current clock and verify a rejection naming the baseline problem and instructing a re-pull, with no document change and no version entry.

**Acceptance Scenarios**:

1. **Given** a push whose baseline clock exceeds the document's current clock (or is negative/non-numeric), **When** processed, **Then** it is rejected with a baseline-invalid error including re-pull guidance, and the document is unchanged.
2. **Given** a hypothetical future retention window and a push whose baseline clock falls outside it, **Then** it is rejected with a baseline-unavailable error including re-pull guidance — the server MUST NOT silently degrade to whole-document replacement.
3. **Given** a push with no baseline clock in frontmatter and no explicit baseline parameter, **Then** it is rejected as a sync push (the non-sync import modes from feature 002 remain available for clobber-style writes).
4. **Given** a push whose frontmatter names a different document than the target of the request, **Then** it is rejected before any processing.

---

### Edge Cases

- **Baseline equals current clock** (nobody edited meanwhile): the degenerate case of the same path — no special fast path, identical mechanics, no overlaps.
- **Duplicate/retried push** (same file pushed twice, e.g. network retry): replay is deterministic for identical input (same document, baseline, and canonical content), so re-applying is idempotent — content is not duplicated. See ratified default D5.
- **Pushed file empties the document**: replays as deletion of every block — a legitimate edit, flagged as overlap where doc-side edits existed, recoverable via version history restore.
- **Unparseable or hostile markdown**: parser's never-lose-content rule applies (degrades to literal paragraphs); HTML never executes (whitelist from 001); the push otherwise proceeds as a structural edit. Pushed content is untrusted input end to end.
- **Lossy portable file with concurrent doc-side styling**: character-level ops leave doc-side lossy marks (underline, color) intact; only structurally replaced blocks lose them; `lossy:`-listed marks are excluded from the diff so degradation never masquerades as an edit.
- **Images**: `./assets/` references resolve back to original image ids via the frontmatter mapping (003); unchanged image references produce no ops; external URLs follow 002's import image policy.
- **Document deleted or not accessible**: standard not-found / access-denied responses from the import route (002); no partial state.
- **Very large pushes**: payload limits inherited from feature 002; within limits, the push processes the full document diff.
- **Non-Squire frontmatter** in the pushed file: preserved as document content per 003's contract; only the `squire:` block is consumed by the protocol.
- **Persistence failure mid-apply**: the push's update is applied through the normal single-update write path — it either lands (one update, one clock) or the push fails whole; no partial replay is observable.

## Requirements *(mandatory)*

### Functional Requirements

**Protocol surface**

- **FR-001**: The import route for an existing document (feature 002) MUST accept a sync mode (`mode=sync`) whose body is the markdown file content (frontmatter included). Sync mode MUST require a baseline clock, taken from the file's `squire.clock` frontmatter; an explicit request parameter MAY override the frontmatter (for tooling that strips frontmatter). Absent both, the push is rejected.
- **FR-002**: If the pushed frontmatter carries a `docGuid`, it MUST match the request's target document; mismatch is rejected before any processing.
- **FR-003**: Sync pushes MUST enforce the same trust boundary as all imports: authenticated (session or scoped/expiring API token with `documents:write`), per-document write access re-checked on every push, pushed markdown treated as untrusted input (parser HTML whitelist, no execution, image-source guardrails per 002/003).

**Baseline, diff, and replay**

- **FR-004**: The server MUST reconstruct the document's full CRDT state at the baseline clock from the update log and fork it under a synthetic client identity representing this push. The live document MUST NOT be consulted by or mutated during diff computation and replay — only the file and its own ancestor are compared, so there are no merge decisions.
- **FR-005**: The pushed markdown MUST be canonicalized (parsed and re-serialized through the canonical serializer) before diffing, and then character-diffed against the baseline's canonical markdown. Markdown-formatting equivalences MUST canonicalize to an empty diff.
- **FR-006**: The canonical serializer MUST produce a source map alongside its output: every emitted text run maps its markdown character range to the underlying text node and offset; syntax characters (heading markers, emphasis delimiters, list markers, fences, table pipes) map to structure, not text.
- **FR-007**: Each diff hunk MUST be classified: **text hunks** (falling entirely within one block's mapped text) replay as character-level insert/delete/format operations on the fork, preserving all untouched text and marks in the block; **structural hunks** (touching syntax characters or crossing block boundaries, including whole-block insertions/deletions) replay as block replacement using parsed content. The classifier MUST prefer the text interpretation whenever a hunk can be expressed as one, because structural replacement is the coarser, more destructive operation.
- **FR-008**: The fork's update-since-baseline MUST be encoded and applied to the live document through the normal update path (persistence, attribution, live broadcast, search indexing) as a single stored update. Application MUST be order-independent with respect to concurrent live edits: no conflict states, no conflict-based rejection (no 409-on-conflict), no compare-and-set, no retry loop. Applying a push MUST NOT delete-and-recreate untouched content — CRDT identity of unedited content survives (Constitution IV).
- **FR-009**: A push whose canonical diff is empty MUST generate zero operations, store no update, create no version entry, and respond as an explicit no-op with the document's current clock.
- **FR-010**: Marks listed in the pushed file's `lossy:` frontmatter MUST be excluded from diff computation so flavor degradation never registers as an edit; character-level ops MUST leave doc-side instances of those marks intact except inside structurally replaced blocks.
- **FR-011**: Replay MUST be deterministic: identical (document, baseline clock, canonical pushed content) inputs produce an identical update, making retried pushes idempotent under CRDT application (no duplicated content).

**Overlap flags**

- **FR-012**: Using state-vector comparison between the baseline and the live document, the server MUST identify blocks changed on the document side since the baseline; every such block that push-side operations also touched MUST be reported in the response as an overlap flag. Overlap flags are strictly advisory — they MUST never block, delay, or alter the application of the push.

**Attribution**

- **FR-013**: Push operations MUST land under the pushing credential's identity through the standard origin/attribution model, producing a normal version-history entry (agent-style attribution, no privileged write path). The push MAY carry optional on-behalf-of metadata (author name, author email, commit identifier); when present it MUST be recorded with the push's version entry and surfaced in version history, rendered strictly as text (length-capped, never interpreted as markup).

**Response**

- **FR-014**: A successful content-changing push MUST respond with: the new clock; a canonical re-export of the post-push document in the pushed file's flavor with refreshed frontmatter (so the sync tool can rewrite the local file as an immediately valid next baseline, including any concurrent doc-side edits); the overlap flags; and a summary of applied operations (counts of text and structural hunks).
- **FR-015**: A push whose baseline cannot be used MUST be rejected with a machine-readable error distinguishing **invalid baseline** (malformed, negative, or beyond the document's current clock) from **unavailable baseline** (a clock the server can no longer reconstruct), each including guidance to re-pull the document and re-apply edits on a fresh baseline. Rejected pushes MUST leave no trace: no document change, no version entry. The server MUST NOT fall back to whole-document replacement. (Today the full update log is retained — every historical clock is reconstructible — so the unavailable-baseline path is a forward guard; any future compaction/retention policy MUST keep this error contract. See ratified default D1.)

**Standing verification**

- **FR-016**: The round-trip invariant becomes a standing CI property: for any document, `import(export(doc))` is a no-op (empty canonical diff, zero ops, no version entry) and `export → import → export` is byte-stable in the canonical (squire) flavor. The registry-driven round-trip suite is the enforcement point, so new marks/nodes inherit coverage by construction (Constitution II).
- **FR-017**: Protocol behavior MUST be covered by tests at the API level: text-hunk replay, structural-hunk replay, the convergence property (a push MUST yield the same final document state as a real offline CRDT client making the same edits against the same baseline and reconnecting), overlap flagging, and edits arriving mid-push (order-independence; there is deliberately no retry path to test because none exists).

### Key Entities

- **Sync push**: one request — markdown file content + baseline clock + credentials (+ optional on-behalf-of metadata) targeting one document.
- **Baseline**: the document's reconstructed CRDT state at the frontmatter clock; the shared ancestor of both edit streams. A pointer into version history, not a conflict-detection token.
- **Fork (synthetic collaborator)**: the baseline copy, owned by a synthetic client identity, onto which pushed edits are replayed; its delta-since-baseline is the entire effect of the push.
- **Source map**: serializer byproduct mapping each markdown character range to its originating text node and offset (or to structure, for syntax characters); the bridge from text diff to CRDT operations.
- **Diff hunk**: one contiguous change between baseline and pushed canonical markdown, classified as text (character ops) or structural (block replacement).
- **Overlap flag**: an advisory marker for a block changed on both sides since the baseline, carried in the push response; reviewed after the fact in version history.
- **Push receipt (response)**: new clock, canonical re-export (the next baseline), overlap flags, operation summary — or an explicit no-op / baseline-rejection outcome.
- **On-behalf-of attribution**: optional provenance metadata (author, commit) recorded on the push's version entry beneath the credential's identity.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every document in the round-trip corpus, exporting and immediately pushing the file back produces zero operations and no version entry — enforced continuously in CI, 100% of cases.
- **SC-002**: Across the sync property-test corpus, a push produces a final document state identical to a real offline collaborator having made the same edits against the same baseline — 100% of generated cases, including cases with concurrent live edits.
- **SC-003**: A text edit confined to one block never disturbs any other content: all untouched text and formatting in the document (including within the edited block) survives the push intact, in 100% of text-hunk cases.
- **SC-004**: Concurrent live editing never causes a push to fail, retry, or lose either side's edits: with edits injected at any point during push processing, the final state contains both edit streams and is independent of arrival order, in 100% of tested interleavings.
- **SC-005**: Every content-changing push appears in version history attributed to the pushing identity, with supplied on-behalf-of details visible — 100% of pushes.
- **SC-006**: Every block edited on both sides since the baseline is flagged in the push response (no false negatives in the test corpus), and zero pushes are blocked or delayed on account of overlaps.
- **SC-007**: A push against a typical document (up to 1 MB of markdown, within the import payload limits) completes and returns its receipt in under 10 seconds.
- **SC-008**: Pushes with invalid or unavailable baselines are rejected with actionable re-pull guidance and zero document mutation in 100% of cases; no code path performs whole-document replacement as a fallback.
- **SC-009**: A pull → external edit → push → rewrite-local-file cycle can be repeated indefinitely without phantom edits: the second and subsequent unedited pushes are no-ops, 100% of the time.

## Assumptions

- Feature 002's `PUT` import route, `documents:write` scope, authentication plumbing, payload limits, and external-image import policy exist as specified there; this feature only adds the sync mode and its semantics.
- Feature 003's frontmatter contract (`docGuid`, `clock`, `flavor`, `lossy`, image mapping), portable-flavor degradations, and task-list schema exist as specified there; the pushed file and the response re-export both speak that contract.
- Feature 001's tolerant parser (never-lose-content, HTML whitelist) is the parsing layer for canonicalization and structural replacement.
- The persistence layer retains the full per-document update log with a shared monotonic clock and can reconstruct document state at any historical clock (true today: no compaction exists). The state-vector-at-clock capability needed for overlap detection exists in the same layer.
- Version history's existing attribution model (per-update user + agent identity) is the vehicle for push attribution; on-behalf-of is additive metadata, not a parallel identity system.
- The reference sync CLI / GitHub Action (M5) is a separate feature; this feature's contract is API-first so that tooling — or any third-party client — can implement pull/push against it.

## Out of Scope

- The markdown parser itself (feature 001) and import transport basics (feature 002).
- Portable flavor, frontmatter emission, asset bundling, and task-list schema (feature 003) — consumed here, not defined here.
- The `squire-sync` CLI and GitHub Action (M5), editor paste conversion, and any raw-markdown editor view.
- Any conflict-resolution interface, pending-conflict state, or merge UI — excluded by design, not deferred: overlap review happens in the existing version-diff view.
- Defining a version-history retention/compaction policy (only the rejection contract for unreconstructible baselines is specified here; see ratified default D1).
- Per-document token scoping (see ratified default D2).
- Webhooks/watch for push-triggered pulls — polling with `updatedSince` remains the pull mechanism.
