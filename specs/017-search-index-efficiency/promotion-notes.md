# Feature 017 — promotion notes

## Post-merge review dispositions (2026-07-18, Fable review of 0dcaef8)

Verdict: MERGE STANDS — zero HIGH/MEDIUM findings; the ACL invariant, gate
atomicity, no-key case, empty-content terminal state, model repair, param
indexing, and byte-identical absent-param SQL all survived adversarial
scrutiny (see the review's verified-correct list).

- **F1 (LOW) FIXED**: list_documents description was 2,049 UTF-8 bytes (2,045
  chars) — over a byte-based 2KB truncation; the char-based test masked it.
  One em-dash swapped for '-' → 2,047 bytes. The full chars→bytes gate
  conversion lands with 019 (its T003).
- **F2 (LOW) FIXED**: parseUpdatedAfter accepted any V8-parseable date string
  (e.g. "07/01/2026"), parsed in SERVER-LOCAL time — a typo'd format got a
  silently TZ-shifted window instead of the promised 400. Now strict ISO-8601
  prefix.
- **F3 (LOW) FORWARDED to 018**: the hash seam has two hidden producers behind
  default args (generateAndStoreEmbeddings' default param; the backfill
  script's hash-less call) — both must change with 018's title-aware seam or
  backfilled docs silently re-embed once. Sent to the 018 implementer
  mid-flight.
- **F4 (LOW) FIXED**: the two global embed-call-count assertions in the
  watermark suite could be inflated by stale fixture docs leaked from a prior
  killed run (the known serial-DB heal issue). healStragglers() now resets
  indexed_at/embedding_model before those tests.
- **F5 (INFO) ACCEPTED**: the api-docs inline-handler copy remains pre-existing
  drift (narrowed by T011, not eliminated); the extract-handler refactor stays
  out of scope. Revisit if the copy bites again.

## Owed / deferred
- CN-4 posture (no failed-embed boot hunt) is ratified, not a gap.
- C1 from analyze: documents.updated_at has no index — mechanism honored via
  PK join; a literal index is a one-line later migration if scale demands.
- Quickstart manual provider scenarios (real-key zero-traffic observation,
  live model-flip reboot) remain with Sam.
