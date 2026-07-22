# Contract: Hardened coaching-contract checklist

The grading contract the harness/matrix runner apply to each rehearsal transcript. Extends the 029 seven-item checklist (`test/first-run/grade-transcript.mjs`) with the M2 hardening (FR-025..028, RBD-2/10). Interface: `gradeTranscript(capture, { serverOrigin })` where `capture = { prose, events }` (R1) returns `{ items:[{id,name,kind,pass}], passed, failed, total }`.

## Item kinds

- **prose** — matched (semantically) against `capture.prose`.
- **behavioral** — matched against the shape/ordering of `capture.prose` (presence/absence of a ceremony block relative to a step transition).
- **performable** — matched against `capture.events` (tool-call events); **fails closed** when the expected event data is absent (RBD-2), never falling back to prose.

## Items

| # | Name | Kind | Pass condition |
|---|---|---|---|
| 1 | signup-creates-account line before the browser step | prose | The expectation-line semantics ("signing in with Google creates your account if you've never used Squire Docs") appears, positioned before the first browser/authorize/consent mention. Matcher tracks authored wording (semantic, ledger gap 7 / FR-026). |
| 2 | bare authorization URL on its own line | prose/structural | An authorization/OAuth URL appears bare on its own line (no list markup, quotes, trailing punctuation) — design-fixed structural element (FR-010). |
| 3 | expected localhost-callback failure handled via paste-back | prose | The expected localhost callback error is explained before the URL is opened, and paste-back-the-full-callback-URL is instructed (FR-010/013). |
| 4 | silent reconnect / no success ceremony | behavioral | After tool presence is (re-)established, the flow proceeds directly into find-the-spec with NO success-ceremony block between consent completion and the spec step. Reconnection prose neither required nor penalized (FR-027, RBD-10). |
| 5 | byte-channel (never-retyped) file sync performed | performable | A tool-call event shows the byte channel used — an `import_markdown_file` recipe run, or a `Bash` `curl` import carrying an `sk_sqd_` token, or the export API — NOT prose describing it. Fails closed without such an event (FR-026). |
| 6 | doc URL delivered (the payoff) | performable | A delivered URL's origin equals `serverOrigin` AND a doc-creating/import tool-call event corroborates it (or equivalent server-side evidence). Incidental `/d/…` paths and other-origin URLs fail (FR-025). |
| 7 | the loop taught (read-before / write-back-after) | prose | The standing behavior is stated: agent reads the spec before each run, writes status/design back after; teammates/other agents see attributed edits in the same doc (FR-017). |

## Grading rules

- Prose items graded semantically, not byte-exact (RBD-8); design-fixed structural elements (item 2's bare-URL) checked structurally.
- Performable items (5, 6) require events; absent events → FAIL (never a prose fallback).
- `--require-all` (existing flag) remains valid for full happy-path cells; per-cell reachability is expressed via cell profiles (see `matrix-cell-profile.md`), not by weakening the checklist globally.
- Regression fixtures (FR-028, SC-003): quote-only → items 5,6 FAIL; incidental-`/d/…`-path → item 6 FAIL; genuine performing → items 5,6 PASS. These run in the standard suite.
