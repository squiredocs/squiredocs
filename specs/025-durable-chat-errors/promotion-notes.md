# Promotion Notes — 025-durable-chat-errors

Feature 025 persists classified chat-turn failures into the transcript (a
`{code, provider, at}` record stamped on the failed turn's trailing *user* message),
tears down the resumable-stream entry on a classified failure, and renders every
error banner from one durable per-chat turn-error state (fed by live error events +
the loaded transcript) — never from the SDK's transient stream status. Merged at
`ed2cf1f`.

## Post-merge review dispositions (2026-07-21, fixes)

Fable reviewer findings against merge `ed2cf1f`. All five fixed same day, directly on
`main` (backend suite on a per-agent DB, client vitest, and `npm run build` all green).

- **F1 (MEDIUM) — wrong-turn stamp on a pre-save throw.** FR-006 was implemented as
  "no user message at all" (`u < 0`), so a throw between handler entry and the
  user-message save (e.g. a transient `loadChat`/`saveChat` failure) reached the outer
  catch and stamped the PREVIOUS, already-answered turn — a durable false-failure
  banner + false interruption surviving reloads. **Fix** (`server/api/chat.js`): a
  `userTurnPersisted` flag is set the instant this turn's user message is saved;
  `stampTurnFailure` returns early unless it is set. Belt-and-braces: the RMW also
  verifies the transcript's trailing user message id still matches this turn's incoming
  message id before stamping. Regression test added
  (`chat.durable-failures.test.js`): a pre-save `loadChat` throw → outer catch
  classifies `internal` → NO stamp lands on the prior turn.

- **F2 (MEDIUM) — a reply landing after `waitForReply`'s deadline never cleared the
  live error.** `RECONNECT_ESTABLISH_MS` now bounds time-to-first-CONTENT, so a resumed
  stream with slow TTFT fell back (banner + restored draft) and, when the reply landed
  seconds later, nothing cleared the stale turn-error — a successful answer beside a
  "Something went wrong" banner and a duplicate-send draft. **Fix**
  (`AiChatContext.jsx`): after a recovery fallback, a bounded background watcher
  (`watchForLateReply`, up to `LATE_REPLY_WATCH_MS` = 60s) clears the chat's live
  turn-error when an assistant reply with content lands on that instance, and withdraws
  the restored draft ONLY if the user hasn't typed over it. The stale wait-for-START
  comment was corrected to the wait-for-CONTENT semantics. Client test added
  (`AiChatContext.banner-persistence.test.jsx`): timeout → banner + draft → late reply
  → banner + untouched draft cleared.

- **F3 (LOW) — over-claiming comment + narrow race on unclassified-throw paths.** The
  outer-catch comment claimed "both writers apply the SAME record", but a failed
  compaction / `INVALID_ARGUMENT` retry can have a run's fire-and-forget onFinish save
  race the outer-catch RMW with one writer unstamped. **Fix** (`server/api/chat.js`):
  the RMW now re-reads-and-MERGES — preserving any partial reply already persisted AND
  any existing stamp (keep it, add nothing) while ensuring the record is present —
  rather than assuming convergence. The comment now describes the actual guarantee and
  honestly documents the residual (a still-in-flight onFinish save landing strictly
  after the awaited RMW could clobber the stamp on that retry path; accepted, LOW,
  failures are rare) instead of asserting convergence.

- **F4 (LOW) — README over-claims.** The "Durable error surfacing" bullet was tightened:
  (a) "Every chat-turn failure" → *classified* failures, listing the out-of-taxonomy
  paths that are deliberately not stamped (tagged attachment 4xx, pre-save stream-cap
  429, token-limit/`INVALID_ARGUMENT` retries) plus the pre-persist live-only case;
  (b) "replay-and-tail window applies to successful turns only" → to turns *without a
  classified failure* (an after-content `INVALID_ARGUMENT` retry keeps its buffer by
  design); (c) "neutralized by a later assistant reply" → the persisted stamp is
  neutralized by the next *user* turn (trailing-turn keying); a landed reply clears only
  the live per-chat entry, and an interrupted partial keeps its notice (US5). Kept as
  one bullet, with the late-reply watcher noted.

- **F5 (LOW) — false parity docstring / dead export.** `chatTurnError.js` claimed the
  helpers were "shared verbatim by the client context and the server stamp writer
  (parity)" — they are not: the module is client-side ESM, the CJS server cannot import
  it and re-implements the stamp write inline, and `stampFailure` has zero non-test
  consumers. Since the ESM/CJS boundary rules out actually sharing it, the docstring was
  corrected to client-only truth: `deriveTurnError`/`hasPartialReply` are the client's
  read-side derivations, and `stampFailure` is kept with an honest "client-side
  test/simulation helper (no production consumer)" note — its unit tests use it to build
  a stamped transcript for the read-side derivations.
