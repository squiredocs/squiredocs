# Clarifications Ledger — 018-search-chunking-and-eval

Decisions the design amendment (`design/content-search.md`, **"Chunking, context, and
evaluation (amendment, Sam, 2026-07-18 — feature 018)"**) did not answer were taken with
the best default and recorded here as **RATIFIED-BY-DEFAULT (Sam pre-authorized,
2026-07-18)** per Constitution Principle VI.

Decisions the amendment already made are Sam-ratified 2026-07-18 and are cited in the
spec, not re-decided: structure-aware heading-boundary chunking at ~600 tokens with a
per-chunk heading_path, replacing the 6000-char/500-overlap windows; contextual
preambles (1–3 LLM-written situating sentences, embedded AND keyword-indexed with the
chunk) for multi-chunk documents ONLY — single-chunk documents get none; the 017 content
hash covers only extracted document text, never preambles (017 lands first; 018 rides
its re-embed gate); the doc-level RRF response shape preserved (chunk hits roll up to
documents; API/MCP contracts frozen); the eval harness first-class on main, re-ported
from the reference-only `rag-search-v2` branch (never merged), with Recall@k / MRR /
nDCG / recall@token-budget, a variant-sweep runner, and a curated long-tail eval set
replacing the saturated LLM-drafted set; build-now-measure-before/after (measurement
informs tuning, does not gate); reranker stays off by default, remains a flag.

---

## RBD-1: Chunk packing, splitting, overlap, and token accounting

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment pins "heading-boundary splits, ~600-token chunks" but not
  the mechanics: when does a heading actually force a break vs get packed with its
  neighbors? How do oversized sections split? Is there overlap between adjacent chunks?
  What counts a "token"?
- **Decision**: Adopt the re-ported v2 chunker's semantics as the default contract
  (`git show rag-search-v2:server/search/chunker.js`), stated as requirements
  (spec FR-003/FR-004/FR-007): a heading forces a new chunk only once the current chunk
  is at least half full (tiny sections pack together); a section exceeding the target
  splits at sentence boundaries, hard character-splitting only for text with no sentence
  boundaries; adjacent chunks carry a small deterministic sentence-boundary overlap
  bounded at ~12% of the target; tokens are estimated by a consistent cheap heuristic
  (chars/4-class), with ~600 a target rather than a hard cap. All knobs (target size,
  fill ratio, overlap ratio) are configuration the eval can sweep. Determinism (FR-006)
  is non-negotiable regardless of knob values.
- **Why this default**: These are the already-written, already-reasoned semantics of the
  branch the amendment says to re-port; they directly implement the "200–800 tokens,
  split on structure, small overlap" guidance the branch was built from. Exact-tokenizer
  accounting would buy nothing measurable while coupling the chunker to a model vendor.
  Keeping the knobs sweepable lets the new eval — not this ledger — settle tuning.

## RBD-2: Chunk storage layout and the legacy re-chunk rollout

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: Do chunks live in a new table or in extended `document_embeddings`
  columns? And what happens to the corpus indexed under the old fixed-window scheme?
- **Decision**: The spec pins only the durable data contract (FR-008: doc ref, ordinal,
  text, heading_path, optional preamble, embedding, embedding model id) and the
  migration slot `1798000000000` (FR-009; must exceed `1795000000000` per the
  migration-ordering constraint). New-table vs extend-in-place is the plan's decision.
  Rollout (FR-011): the migration does NOT synchronously re-embed; existing old-scheme
  chunks keep serving search, and a background best-effort concurrency-capped re-chunk
  (the same shape as the existing `reindexStale()` boot repair, which 017 already
  extends for model mismatches) migrates documents over time, each document swapping
  transactionally.
- **Why this default**: Search must never go dark for a schema upgrade (SC-012), and
  embedding/preamble backfill requires external API calls that have no place inside a
  migration (the original search migration already set this precedent by backfilling
  tsvector only). Pinning the contract but not the layout keeps the spec at requirement
  altitude while making the data durable enough for 017's model-repair machinery and
  future features to rely on.

## RBD-3: Preamble text is retrieval-only — never displayed as document content

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: Semantic-only hits currently show an excerpt of the matched chunk's
  stored text. If the preamble is stored/indexed "with the chunk", a naive excerpt would
  show LLM-generated sentences as if the document said them. Is that acceptable?
- **Decision**: No. User-visible snippets and excerpts come from document-authored text
  only; generated preamble text is a retrieval aid and never surfaces as document
  content (spec FR-018, US2 scenario 6). Preambles influence *ranking and matching*,
  not *display*.
- **Why this default**: Provenance is a product invariant (Constitution IV/V):
  presenting generated text as document content would misattribute words to the
  document's authors, and a hallucinated preamble sentence shown in a snippet would be
  indistinguishable from a real quote. The cost is one requirement on excerpt sourcing;
  the alternative silently corrupts trust in search results.

## RBD-4: Preamble generation inputs, model, and cost bounds

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: What exactly feeds preamble generation, which model runs it, and what
  bounds the spend per document?
- **Decision**: Generation input is the parent document (title + extracted text,
  size-capped) plus each chunk with its heading trail; the document is sent ONCE per
  document with its chunks batched in bounded-size groups, amortizing document tokens
  across all chunks (spec FR-013/FR-017) — the re-ported contextualizer's shape. The
  model is an inexpensive large-context model reached through the application's
  existing AI-provider configuration (Constitution: provider behavior lives in the
  provider registry); no new provider integration. Combined with the ratified
  multi-chunk-only rule and the 017 hash gate, per-document generation cost is bounded
  and idle cost is zero (SC-007).
- **Why this default**: Per-chunk full-document prompts multiply document tokens by
  chunk count for no quality gain; the batched-once shape is the branch's tested cost
  lever and matches the amendment's "eliminates most contextualizer cost" intent.
  Routing through the existing provider registry is a constitution constraint, not a
  preference.

## RBD-5: Curated eval set — format, composition minimums, and what "discriminates" means

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment mandates a curated long-tail set (paraphrased/conceptual,
  multi-doc, no-answer) but pins no format, no size, and no test for "not saturated".
- **Decision**: Format (FR-027): a versioned JSON file committed on main, one record per
  query with query text, type tag, and expected relevant document references (empty
  array for no-answer), plus a set-level version/date. Minimum composition: **≥ 40
  queries total, of which ≥ 12 paraphrased/conceptual (query shares no distinctive
  keywords with its target's literal text), ≥ 6 multi-document (≥ 2 relevant docs),
  ≥ 6 no-answer**; single-doc keyword-ish queries may fill the remainder as a sanity
  floor. Saturation guard (FR-028, SC-009): the set **discriminates** iff, across the
  minimum variant sweep (old chunking / new chunking / new+preambles), (a) NOT all
  variants score 1.0 on all of Recall@5/10/20, and (b) at least one primary metric
  (Recall@10, MRR, or nDCG@10) differs between some pair of variants by ≥ 0.03. A set
  failing the guard is a defect in the set — fixed by adding harder queries, never by
  concluding the variants are equal.
- **Why this default**: The prior draft set's failure mode is precisely documented (all
  variants Recall@5/10/20 = 1.0; the reranker's harm invisible until MRR was read) —
  the guard is written to make that exact outcome a red flag. The composition minimums
  weight the categories the amendment names, sized to be curatable by one operator in
  one sitting while large enough for averaged metrics to move meaningfully. Concrete
  numbers make SC-009 auditable; Sam can raise them any time by editing the set.

## RBD-6: Before/after measurement protocol and where it is published

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: "Before/after" against which corpus, run by whom, published where? And
  is the harness part of CI?
- **Decision**: The before/after comparison (FR-029, SC-010) runs on the operator's
  populated development corpus (the same corpus the curated set is authored against),
  using the same eval-set version for both sides, executed via the one-command harness;
  the resulting table — with variant configurations and eval-set version identified —
  is published in the feature's promotion notes (the pipeline's existing promotion
  artifact). The harness is an on-demand operator tool: it is NOT wired into the
  CI-blocking test suite (it needs live API keys, a populated corpus, and per-variant
  re-indexing); the metric *functions* get ordinary unit tests like any other code.
- **Why this default**: The eval only means something on a corpus the curator knows
  (the documented lesson of the saturated set), and promotion notes are where this
  pipeline already records evidence. Putting API-dependent, corpus-dependent,
  re-indexing runs in CI would make the suite flaky and slow for zero gating value —
  the ratified decision explicitly says measurement does not gate.

## RBD-7: Chunk-count transitions (1 ↔ many) and preamble lifecycle

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: A document's chunk count can cross the single/multi boundary as it is
  edited. When do preambles appear/disappear, and can a stale preamble outlive the rule?
- **Decision**: The multi-chunk-only rule is evaluated per indexing pass, on the chunk
  set that pass produces: chunks and preambles are replaced together, transactionally,
  whenever the 017 hash triggers a re-embed. A document growing 1→2 chunks gains
  preambles on that same pass; one shrinking to a single chunk stores that chunk with
  no preamble on that same pass. No preamble ever survives from a previous chunk set
  (spec edge cases; follows from FR-010/FR-012/FR-015).
- **Why this default**: Any crossing of the boundary is by definition a content change,
  so the hash gate already guarantees a re-index at exactly the right moment — separate
  transition machinery would be dead weight. Whole-set replacement is also what makes
  "preambles present iff multi-chunk" (SC-003) an invariant rather than an eventual
  hope.

## DR-1: Titles join the embedded text; the 017 hash expands to cover the title

- **Status**: DESIGN-RATIFIED (Sam, 2026-07-18) — recorded at plan time
- **Source**: `design/content-search.md`, Addition paragraph "**titles join the
  embedded text**" (Sam, 2026-07-18), which postdates the spec draft. Design wins
  (Constitution VI); the plan folds it in as a requirement rather than re-opening
  the spec.
- **Decision**: From 018 onward, every chunk's embedded text begins with its
  heading_path **headed by the DOCUMENT TITLE** (header line
  `[title, ...heading_path].join(' > ')`, applied to every chunk including
  single-chunk documents and empty heading paths), making titles semantically
  searchable corpus-wide. Corollary: the feature-017 re-embed hash input expands
  from extracted body text to title + body text once the title is part of
  embedded text — a title-only change busts the gate and re-embeds. Preambles
  remain excluded from the hash (FR-015 unchanged). Until 018 lands, 017's
  title-excluded hash remains correct, per the Addition's own corollary.
- **Spec delta note**: the spec (FR-002/FR-015 and 017's FR-001/CN-1 as written)
  predates this Addition and describes a title-excluded hash and a bare
  heading_path. The delta is resolved-by-design: plan.md D3 and
  contracts/chunk-record.md carry the ratified composition and hash scope;
  analyze treats this as resolved, not a stop-the-line conflict.

---

## RBD-8: What "keyword-indexed with the chunk" must observably mean

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: Keyword search today runs over a doc-level index row that also produces
  highlighted snippets. The amendment pins that preambles are "keyword-indexed with the
  chunk" — but not how that composes with the doc-level index, snippets, and doc-level
  ranking.
- **Decision**: The spec pins the observable contract only: (a) a term occurring only
  in a preamble makes the containing document retrievable via keyword matching AND via
  semantic matching (FR-014, SC-005); (b) user-visible snippets come from
  document-authored text (FR-018/FR-020); (c) chunk-level keyword matching, like every
  retrieval path, sits behind the share-join authorization pre-filter (FR-021); (d) the
  response stays doc-level RRF-shaped (FR-019). How the plan realizes this — a
  keyword-indexed column on chunk rows feeding the keyword leg, retention of the
  doc-level index for snippets/ranking, or another composition — is a plan decision
  bounded by those four requirements.
- **Why this default**: The amendment's words pin an outcome, not an index topology;
  specifying table-level mechanics here would cross the spec/plan altitude line and
  pre-empt real trade-offs (snippet quality vs index duplication) that belong in plan
  with the schema decision from RBD-2. The four observable constraints are exactly what
  any implementation must not violate.
