# Clarifications Ledger — 017-search-index-efficiency

Decisions the design doc (`design/content-search.md`, 2026-07-18 amendments "incremental
gating" and "recency pre-filter + entry-point corrections") does not settle, resolved with
best defaults per Constitution Principle VI. Each entry is referenced from `spec.md` as CN-#.
All entries are **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)** unless later
overturned; overturning one is a spec amendment, not a code-level choice.

---

## CN-1: Is the title included in the content hash?

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)**

- **Question**: The amendment says the indexer "stores a hash of the extracted document text" — does that text include the title?
- **Why it matters**: The hash gates *embedding* regeneration. If the title were hashed, every title change would trigger a full re-embed; if excluded, title changes must still refresh the keyword index some other way.
- **Chosen default**: Title **excluded**. The hash covers extracted body text only. Rationale: embeddings are generated from body text only (the title is not embedded — it is keyword-weighted A on the FTS row), so a title change cannot change any vector; and the amendment itself names "title sync" as an example of churn that must cost zero embedding calls. Title changes stay searchable because the FTS row is upserted unconditionally on every indexing pass (spec FR-003).

## CN-2: What timestamp does `updatedAfter` filter on, and how does it relate to the existing MCP `updatedSince`?

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)**

- **Question**: The amendment says `updatedAfter` is "an indexed-column WHERE inside the engine CTEs" but names no column. The MCP list path already has `updatedSince`, which filters on the *last content edit* (derived from the update log) precisely because `documents.updated_at` is also bumped by merely opening a document. Which basis does `updatedAfter` use, and do the two parameters merge?
- **Why it matters**: Two nearby recency parameters with silently different meanings would be an agent trap; but the last-content-edit basis is derived from the update log and is not a simple indexed column suitable for a pre-ranking WHERE inside every engine CTE.
- **Chosen default**: `updatedAfter` filters on the document's **last-updated timestamp** (`documents.updated_at`) — the exact value already surfaced as `updatedAt` on every search result, so what agents filter on is what they can see. Strictly-after (exclusive) comparison. The parameters stay **distinct and path-exclusive**: `updatedSince` remains list-only with its last-content-edit basis; `updatedAfter` is search-only. Both tool description entries explain the difference. Rationale: the search path needs a cheap indexed pre-ranking filter (the design's stated mechanism), result-visible semantics beat hidden precision, and renaming/merging the shipped `updatedSince` would break existing agent callers. The names differ deliberately so neither parameter appears to promise the other's semantics.

## CN-3: `updatedAfter` without a search query — error or ignore?

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)**

- **Question**: The amendment defines `updatedAfter` for *content search*. What happens when a caller passes it on `GET /api/docs` without `searchMode=content`, or on `list_documents` without `search`?
- **Why it matters**: Silently ignoring a filter is the worst failure mode for agents — they would trust an unfiltered result as filtered. But rejecting adds a new error path.
- **Chosen default**: **Explicit error** on both entry points (HTTP 400 on REST; a tool error on MCP), mirroring the precedent the codebase already set for the inverse case (`updatedSince` combined with `search` throws a descriptive error today). Error text points the caller to the right parameter for their path. Rationale: consistency with the existing precedent, and "never silently no-op a filter" is the safer contract for the primary consumers (agents).

## CN-4: When does the stored hash advance, given embedding failures and disabled embeddings — and does boot repair hunt for failed embeds?

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)**

- **Question**: The amendment says the hash lives on the FTS row, but the FTS upsert happens before (and independently of) embedding generation, which is best-effort and can fail or be disabled (no provider key). When is the hash written, and does `reindexStale()` gain a way to find documents whose embeddings failed?
- **Why it matters**: If the hash advances on FTS upsert, a failed embed records the new content as done and the edit's embeddings are silently lost forever (the no-lost-updates requirement). If boot repair must detect failed embeds, it would need to re-extract text for every document at boot, defeating the point.
- **Chosen default**: The hash advances **only when embedding regeneration for exactly that text completes successfully** (atomically with the chunk swap), or when the text has nothing to embed (CN-6). On failure — and when embeddings are disabled for lack of a provider key — the previous hash stays, so the next indexing pass (next edit-triggered index, flush, or a boot repair triggered by time/model staleness) detects the mismatch and retries. Boot repair's trigger set stays **time + model + missing-row** staleness; it does not add a dedicated failed-embed hunt. Rationale: this preserves today's best-effort posture (an embed failure today is likewise only healed by a later indexing event) while guaranteeing the failure can never be recorded as success — the gate can only ever err toward re-embedding, never toward skipping.

## CN-5: Model-repair granularity, gate interaction, and dimensionality

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)**

- **Question**: The amendment says `reindexStale()` repairs "rows whose model differs" — is repair per-row or per-document, does content-hash gating suppress it (the content did not change), and what about vector dimensionality across models?
- **Why it matters**: Per-row repair would re-embed fragments of a document under a new model against neighbors from the old one; hash gating naively applied would make model repair a permanent no-op (content unchanged → skip embed); and a model with different dimensionality cannot share the existing vector column/index.
- **Chosen default**: Repair is **per-document** (any mismatched row marks the whole document model-stale; the normal pipeline re-embeds all its chunks in one atomic swap — a document is never left half-upgraded, and a doc that is both edit-stale and model-stale is processed once). Model staleness **overrides** the content-hash gate. Mixed-model rows remain queryable during the rollout window (repairs are per-document atomic, so every document is internally consistent at all times). **Assumption recorded**: model changes preserve the current 1536 dimensionality; a dimensionality change is an operational/schema event out of scope for this feature. Rationale: per-document atomicity matches the existing embed-then-swap contract; the override is the only reading under which the amendment's "automatic targeted re-embed" can work at all.

## CN-6: Emptied documents — stale chunk cleanup

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)**

- **Question**: Neither the design nor the current code addresses a document whose body text is emptied: today the embed path returns early on zero chunks *without deleting the old chunk rows*, leaving ghost semantic hits. With hash gating, should the hash advance for empty content, and must the ghosts be cleaned?
- **Why it matters**: This latent leak becomes load-bearing under 017: if the hash advances on empty content while old chunks linger, the ghosts are fossilized forever (gating skips every future pass); if the hash never advances, empty documents are re-processed on every update. Either naive choice is wrong.
- **Chosen default**: When content becomes empty/unembeddable, the indexer **removes the document's existing chunk rows and then advances the hash** (delete counts as the successful "regeneration" for empty text). Rationale: it is the only combination that both eliminates ghost results and lets empty documents settle into the zero-cost steady state; it fixes a real (if rare) correctness bug that gating would otherwise entrench. Scoped as part of this feature because 017 is what makes the leak permanent.

## CN-7: Hash-input seam for 018's title expansion (plan-phase addition)

**RATIFIED (Sam, mid-flight design review, 2026-07-18 — design Addition, commit 7433c65)**

- **Question**: The design doc's same-day Addition ("titles join the embedded text") says feature 018 will fold the document title into every chunk's embedded text, at which point the 017 re-embed hash must expand to cover the title (a title change must bust the gate). 017's hash stays body-text-only for its lifetime (CN-1 unchanged — correct, because the title is not embedded until 018). How does 017 avoid making 018's expansion a surgery on the gate?
- **Why it matters**: If hash-input construction is inlined at the gate's call site, 018 must edit gate internals — risking the advance-on-success semantics and the chunker-agnostic contract 018 itself depends on.
- **Decision (relayed by Sam via pipeline coordinator)**: The hash input is constructed by exactly **one exported function** — `buildEmbedHashInput(extractedText)` in `server/search-indexer.js`, the identity function in 017 — and the gate consumes only `computeContentHash(buildEmbedHashInput(...))`. 018 extends the seam to `buildEmbedHashInput(title, extractedText)` as a signature-only change; the gate logic, `content_hash` column, and advance-on-success semantics do not move. A test asserts the gate consumes ONLY this function's output (stored hash equals the seam-derived hash; output is title-independent in 017). No other 017 scope change. Recorded in plan.md AD-1, research.md R2, and `contracts/indexer-internal.md`; FR-001's "extracted document text only" contract is unchanged for 017.
