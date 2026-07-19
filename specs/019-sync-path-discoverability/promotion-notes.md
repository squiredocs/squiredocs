# Feature 019 — promotion notes

## Post-merge review dispositions (2026-07-18, Fable review of 862f5f8)

Verdict: MERGE STANDS. The claim machinery was byte-for-byte preserved
(prepareClaimDelivery refactor proven pure), and every teaching-surface /
byte-budget / DR-1 invariant survived scrutiny. Three security fixes landed
same-hour:

- **F1 (HIGH, pre-existing since feature 004, surfaced+promoted by DR-1) FIXED**:
  cross-document versionId confusion. `getVersionContent` looked up a named
  version by id alone (`getVersionById` — no doc scoping) while access was
  checked only on the passed docGuid, so read_document({docGuid: A,
  versionId: <B's version>}) — and restore/compare, which share the path —
  returned another user's document content. Added the `doc_id !== docGuid`
  guard (the same one set-document-version-name already had) with
  indistinguishable "Version not found" wording. Two-doc regression test in
  version-history.test.js.
- **F2 (MEDIUM-HIGH, new) FIXED**: import_markdown_file hardcoded [read,write]
  mint scopes with no subset check, so a documents:write-only principal
  (a legit ingest-only token) could escalate to read and export every doc.
  Added the caller-scope cap in the handler; write-only-principal test.
- **F3 (MEDIUM, new) FIXED**: docGuid was interpolated into the returned
  server-blessed shell command; validateToolArgs never enforces the schema's
  uuid format, so a crafted docGuid could inject shell (laundered via the
  chat-exposed tool → human paste). Added UUID validation before
  interpolation; injection-attempt + positive-control tests.
- **F4 (LOW) OWED**: claim-window "5 minutes" hardcoded in the command's
  failure branch + description while result.message derives dynamically —
  derive from pendingMints.CLAIM_TTL_SECONDS on next touch.
- **F5 (LOW, pre-existing) OWED**: chat-origin mints carry null minter
  provenance (no chain guard, no per-minter cap, no revocation cascade) —
  give the chat synthetic principal a stable pseudo-minter id. Predates 019
  (chat exposed create_access_token first); 019 added a second chat-reachable
  mint path. Tracked for a follow-up (candidate 022).
