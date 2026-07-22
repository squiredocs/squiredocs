# Grader regression fixtures (feature 030 — plugin logic M2)

These JSONL fixtures exercise the hardened grader (`grade-transcript.mjs`) against the
029 false-PASS vectors. They are `--output-format stream-json` shape (one JSON object
per line: `system`/`assistant`/`user`/`result`), parsed through `capture.mjs` into
`{ prose, events }` and graded via `gradeTranscript(capture, { serverOrigin })`.

Authored in US4 (T016); wired into the standard suite in T017.

| fixture | intent | expected grade |
|---|---|---|
| `quote-only-transcript.jsonl` | model QUOTES the coaching contract (reads skill text aloud) but performs no sync and creates no doc | performable items 5 (byte-channel sync) and 6 (doc-URL) FAIL |
| `incidental-docpath.jsonl` | an incidental `/d/…` path appears in prose (or a wrong-origin URL), with no doc-creating/import tool-call event on the server origin | item 6 (doc-URL) FAILs |
| `genuine-performing.jsonl` | a real byte-channel sync event + a real doc URL on the rehearsal-server origin corroborated by a doc-creating event | items 5 and 6 PASS |

The two legacy plain-text fixtures (`full-coaching-transcript.txt`, `stub-transcript.txt`)
are retired/regenerated in T012 so no caller passes a raw string to the grader.
