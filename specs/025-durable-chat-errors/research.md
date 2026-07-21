# Research & Decisions — 025-durable-chat-errors (Phase 0)

All product decisions were fixed in `clarifications-needed.md` (D1–D8). This file resolves
the two questions the spec/ledger explicitly deferred to plan (the stamp-durability
mechanism, D2/FR-004; the test harness, D8/FR-017) plus the concrete server/client seams,
grounded in the verified code and the AI SDK v6 behavior.

---

## R1 — Stamp-durability mechanism (FR-004 / ledger D2)

**Decision**: A **single turn-scoped failure record (`pendingFailureStamp = { code,
provider, at }`) that every save path applies to the failed turn's trailing user message.**
Concretely:

1. `pendingFailureStamp` is set at the single classification consumption point:
   - mid-stream: inside `classifyStreamError` (the `toUIMessageStream` `onError` seam,
     `chat.js:~931`), captured independently of `capturedStreamSignal` (which the SSE path
     nulls out — the stamp must not be consumed by that).
   - pre-content: alongside each `sendClassifiedError(signal)` call in the post-save early
     returns (usage-limit `:725`, byok-misconfigured `:782`, no-model `:790`, image-
     unsupported `:812`) and the outer catch (`:1115`), from the same `signal`.
2. **The `onFinish` full-replace save is made stamp-aware.** In `runStream`'s
   `onFinish: ({ messages: saved })` (`chat.js:~1028`), before `chatStore.saveChat(...)`,
   if `pendingFailureStamp` is set it applies the record to `saved`'s trailing user message
   metadata. Because the *only* competing full-replace writer (the partial-reply save) now
   always carries the stamp, it can never persist a failed turn *without* it — this closes
   the exact clobber race the spec names ("the onFinish full-replace save lands without it").
3. **Non-streaming paths apply the same record via an awaited read-modify-write.** The
   post-save early returns and the outer catch never invoke `streamText`, so `onFinish`
   never runs for them; they call an awaited `stampTurnFailure(pendingFailureStamp)` that
   `loadChat` → sets `metadata.failure` on the trailing user message → `saveChat`. No
   competing writer on these paths ⇒ race-free.

**Why race-free under any ordering (the D2 invariant):** the failure record is derived once
and applied by *whichever* writer persists the failed turn. The dangerous interleaving —
a late `onFinish` save clobbering a separately-written stamp — cannot occur because the
`onFinish` save itself re-applies `pendingFailureStamp`. If both `onFinish` and the
RMW happen to run (a before-content stream error where `onFinish` still fires), both write
the *same* record; last-writer-wins converges to a stamped transcript.

**Rationale**: matches the design doc's altitude verbatim ("written at the single
server-side classification point, atomically with the turn's final save"). For the
mid-stream path — the only one with a competing full-replace — folding into that save is
genuinely atomic (one write carries partial reply + stamp), strictly better than a
two-write RMW window. For the non-streaming paths there is no "final save" to fold into, so
a direct RMW is the natural, equally race-free choice. The union is one record and one
derivation, applied by every writer.

**Alternatives considered & rejected:**
- *Separate stamp write, ordered before the onFinish save* — the original bug at the
  persistence layer; onFinish clobbers it. Rejected.
- *Pure RMW after awaiting the onFinish save promise for every path* — uniform, but makes
  `onFinish`'s currently fire-and-forget save awaitable and adds a guaranteed extra
  read+write to the mid-stream path plus a transient partial-reply-without-stamp window.
  The stamp-aware onFinish avoids both. Kept as the fallback if a future change makes
  onFinish's message array not safely mutable in place.
- *A dedicated `failures` column / table* — forbidden (no migration; the JSONB store is
  schemaless and additive per Assumptions). Rejected.

**Implementation note**: `saved`'s and the DB-loaded messages' trailing user message may
already carry `metadata` (`refs`, `kind`); the stamp is `metadata = { ...metadata, failure }`
— never a wholesale replace. Guard: only stamp when the trailing message `role === 'user'`
(a mid-stream failure with a partial assistant reply present means the trailing message is
the *assistant* partial — the failure record still belongs on the **user** message that
began the turn, i.e. the last `role === 'user'` entry, so the derivation walks back to it;
see data-model.md).

## R2 — Which failures get stamped (FR-002 / FR-006 / ledger D3)

**Decision**: Stamp at exactly the paths where the turn's user message is already persisted:
- **Mid-stream** classified errors (via stamp-aware onFinish).
- **Post-save early returns**: usage-limit (`:725`), byok-misconfigured (`:782`), no-model
  (`:790`), image-unsupported (`:812`) — user message saved at `:699`.
- **Before-content outer catch** (`:1115`) — user message saved at `:699`.

**Not stamped (FR-006/D3)**: pre-save rejections — the per-user stream cap (`:671`, returns
before `:699`) and any failure on the not-yet-created draft chat. These never set
`pendingFailureStamp` and never call `stampTurnFailure`; they continue to surface via the
live structured error channel only. Enforced structurally (distinct code path returns
before the user-message save), **not** by a "trailing message is user" heuristic — a prior
turn could leave a trailing user message that must not be mis-stamped.

**Rationale**: mirrors the audited reality recorded in ledger D3 exactly; keeps the "single
server-side classification point" honest by stamping only where `classify()` is consumed.

## R3 — Immediate stream-entry teardown (FR-005)

**Decision**: On a classified failure the entry is **deleted immediately and its buffer
cleared**, so `GET /:id/stream` returns `204` (nothing live) instead of replaying a
failure-stripped buffer.

- Add `teardownEntry()`: `entry.done = true; entry.chunks.length = 0;
  activeStreams.delete(chatId)` — synchronous, no delay, buffer emptied.
- **Mid-stream failure** reaches the post-`runStream` epilogue (`:1099`, currently
  `cleanupEntry(30_000)`) because after-content errors are forwarded, not thrown. Branch it:
  if this turn set `pendingFailureStamp`, call `teardownEntry()`; else keep
  `cleanupEntry(30_000)` (the **post-success replay window is unchanged**, FR-005).
- **Outer catch** (`:1103`, currently `cleanupEntry()`): use `teardownEntry()` so a
  before-content failure also leaves nothing to replay.
- Ordering: teardown may run before or after the stamp write; they are independent. The
  live error SSE event has already been delivered, so the client has the signal live; a
  reconnect now gets `204` and derives the outcome from the (stamped) transcript.

**Rationale**: `cleanupEntry` only sets `done` + schedules deletion; while `done` is true
`GET /:id/stream` still *replays* `entry.chunks` then ends (`chat.js:1135-1142`) — a clean
buffer with no error, which is precisely the fabricated-success replay FR-005 forbids.
Clearing the buffer and deleting immediately is the minimal honest fix. `chunks.length = 0`
(not reassignment) so any in-flight tail loop reading the array sees it emptied.

## R4 — Client consolidation to one durable state (FR-007 – FR-011)

**Decision**: Replace the four parallel states with **one durable per-chat map
`turnErrorByChat` + the existing transient `reconnectingChatId`**. Everything derives:

- `turnErrorByChat[chatKey] = { code, provider }` (parsed to `{ text }` for render via
  `parseChatError`). Fed by (a) live error events (`handleChatError`, replacing the
  `setErrorInfoByChat`/`setUsageLimitReached`/`setInterruptedByChat` writes) and (b) the
  loaded transcript's trailing-turn failure record (new: populate on every load / re-sync /
  recovery-refetch / bfcache reload).
- **usage-limit banner** = derivation `turnError?.code === 'app_usage_limit'` (drop the
  `usageLimitReached` boolean).
- **interruption notice** = derivation `turnError present && hasPartialReply(messages)`
  (assistant content follows the stamped user message); text from `turnError`. Drop
  `interruptedByChat`.
- **Neutralization (FR-011b)** is a **read-side derivation** driven by the `failure` stamp,
  not by message position: `deriveTurnError` returns `null` exactly when the **last
  `role === 'user'`** message carries no stamp (a genuine reply landed, or a newer turn
  followed), so the banner self-clears with no write to the transcript. The **live**
  `turnErrorByChat` entry is cleared when a reply lands (covers the pre-persist window).
  **Critical:** neutralization must NOT trigger merely because "the last message is an
  assistant with content" — an interrupted partial reply is exactly that shape yet must keep
  its banner+notice (US5). The stamp on the last user message is the sole discriminator.
- **Supersession (FR-011a)**: `sendMessage` clears `turnErrorByChat[key]` (repoint the
  existing `clearChatError` + `setUsageLimitReached(false)` block).
- **Render gate removed (FR-008)**: `AiChatBody` renders from the durable turn-error prop
  only; `status === 'error' && error` is deleted as a gate.

**Rationale**: exactly Sam's DRY mandate (four → one + flag). Deriving usage-limit and
interruption removes the two latches whose independent clearing caused the divergence. The
`errorInfoByChat` map already exists and is per-chat — this promotes it to the single source
and adds the transcript feed that makes it *durable* across reloads.

## R5 — Honest recovery (FR-012) & the reconnecting flag (D7)

**Decision**:
- Replace `waitForEstablish` (resolves on `status ∈ {submitted, streaming}`) with
  **`waitForReply`**: resolve `true` only when an assistant message with visible content
  lands (`lastRole === 'assistant'` **and** the message has non-empty content parts), else
  `false` at the deadline. Status transitions alone never count as success.
- `recoverChat`'s DB-refetch branch is unchanged in spirit: if the refetch shows the turn
  answered (`!isAwaitingAssistant`), that *is* a landed reply → success. The reconnect
  branch reattaches then `waitForReply`; a resume that only flips status without content →
  `false` → banner stays.
- **Defense in depth**: because the banner is now derived from durable `turnErrorByChat`
  (not cleared by recovery unless a reply lands), even a mis-reported recovery success
  cannot hide an unaddressed failure. `instance.clearError?.()` becomes cosmetic-to-SDK
  only and never clears the durable banner.
- **Reconnecting flag (D7)**: stays a separate transient per-chat flag, only set for
  non-fatal recovery. It may take visual precedence *while the attempt is in flight*, but
  once the attempt concludes without a landed reply the durable banner shows. The single
  required change in `AiChatBody` is that the error branch no longer depends on SDK status,
  so when `reconnecting` clears the durable banner is already there.

**Rationale**: the false-success recovery path is the specific mechanism that cleared the
banner in the reported bug; `waitForReply` fixes it at the source and the derived banner is
the belt-and-suspenders the design demands ("a failed recovery must leave the error banner
visible regardless of what state the transport machinery ends in").

## R6 — Regression-test harness (FR-017 / ledger D8)

**Decision**: For the banner-persistence scenarios, drive the **real `@ai-sdk/react` `Chat`
class with a scripted fake transport** (`client/src/test/scriptedChatTransport.js`). The
transport yields scripted UI-message-stream chunks and can script: an error part; a
`reconnectToStream` returning a non-null stream (SDK sets `status: 'submitted'`,
`error: undefined`) vs `null`/204 (early return, status untouched); and a clean replay that
ends at `'ready'`. Tests assert the *derived banner* stays through each transition and that
a transcript bearing a `metadata.failure` record populates the banner on load.

The existing `AiChatContext.test.jsx` mocked-SDK suite is **retained** for the paths it
already covers faithfully (401 refresh, fatal-vs-recovery routing, resume-call gating) but
is **not** trusted for status-transition fidelity — that is the real-`Chat` suite's job.
Pure derivations (`deriveTurnError`, `hasPartialReply`, `stampFailure`) get fast plain-unit
tests in `chatTurnError.test.js`.

**Rationale**: D8 names behavioral fidelity as the bar and the real-`Chat` option as the
stronger guarantee (immune to the mock re-drifting). The bug shipped precisely because the
mock never modeled resume clearing error state; a hand-rolled higher-fidelity mock could
re-drift the same way, so the real class earns its setup cost here. Verified SDK behavior
(from `client/node_modules/ai/dist/index.mjs`): `reconnectToStream` null (204) → early
return, status untouched; non-null → `setStatus('submitted')` + error cleared; clean stream
end → `'ready'`; error part → throw → `onError` + status `'error'` — the scripted transport
reproduces each.

## R7 — Additive-safety for legacy transcripts, model history & compaction (FR-016 / Assumptions)

**Decision**: The failure record lives under `message.metadata.failure`. Existing consumers:
- **Model history** (`convertToModelMessages`) ignores `metadata` — the record never reaches
  a provider (verify in a task; `refs`/`kind` metadata already ride this path safely).
- **`validateUIMessages`** treats `metadata` as loose passthrough (again, `refs`/`kind`
  already prove this) — a task asserts an unknown `metadata.failure` key survives validation.
- **Compaction / history hygiene** must carry or drop the record without error; it is only
  meaningful on the trailing turn, so dropping it during summarization of older turns is
  harmless (Assumptions).
- **Legacy transcripts** (no `metadata.failure`) → `deriveTurnError` returns `null` →
  renders exactly as today (FR-016). **Unknown/future code** in a record →
  `parseChatError` already falls back to `internal` copy (D6) — reused unchanged.

**Rationale**: the record is purely additive metadata on an object that already carries
optional metadata; the risk surface is "does an existing consumer choke on an unknown key",
which the plan pins with explicit assertions rather than assuming.
