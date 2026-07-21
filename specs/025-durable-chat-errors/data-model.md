# Data Model — 025-durable-chat-errors (Phase 1)

No database schema change. The two new shapes are (1) the persisted failure record
(additive metadata inside the existing `chats.messages` JSONB) and (2) the consolidated
client turn-error state. Everything else is derivation.

---

## 1. Turn failure record (persisted)

**Location**: `message.metadata.failure` on the failed turn's **trailing user message**
(the last `role === 'user'` entry of the turn), inside the `chats.messages` UIMessage array.

**Shape** (FR-001 / D1 — codes only, no raw text):

```jsonc
{
  "code": "app_usage_limit",   // taxonomy code from server/api/chat-errors.js CODES
  "provider": "anthropic",      // provider id when known; omitted otherwise
  "at": "2026-07-21T16:20:00.000Z"  // ISO timestamp of classification
}
```

- `code` — one of the taxonomy codes (`app_usage_limit`, `byok_insufficient_credits`,
  `byok_invalid_key`, `byok_misconfigured`, `rate_limited`, `provider_overloaded`,
  `model_no_image_support`, `internal`). An unrecognized/future code renders `internal`
  copy client-side (D6) — never stored as raw text.
- `provider` — present only when `classify()` attributed a provider (`signal.provider`);
  omitted for provider-agnostic codes (matches the wire payload's optional `provider`).
- `at` — cheap debugging/staleness aid; **nothing in this feature renders it** (D1).

**Validation / invariants**:
- Written **once** at the single server-side classification point (FR-002); never explicitly
  cleared or rewritten (FR-011 — supersession/neutralization are read-side).
- Additive: applied as `metadata = { ...existingMetadata, failure }` — never replaces
  sibling metadata (`refs`, `kind`).
- Stamp-durability invariant (FR-004): after a failed turn the stored transcript contains
  this record under any write ordering (mechanism: research.md R1).
- Never carries provider free-text (FR-003 / Principle V — no leak into durable storage).

**Lifecycle** (position-derived, no state machine of its own):

The discriminator is always **the `failure` stamp on the last `role === 'user'` message**,
not message position:

| Transcript trailing state (last user message)                  | Banner derived |
|----------------------------------------------------------------|----------------|
| last user msg has `failure`, nothing after it                  | failed-turn banner |
| last user msg has `failure`, partial assistant content after   | interrupted-partial (notice + banner) |
| last user msg has **no** `failure` (a new/answered turn is last)| none (neutralized/superseded) |
| `failure` only on an **older** user message (a later user turn is last) | none (inert history) |
| no `failure` anywhere (legacy or clean)                        | none |

## 2. Durable client turn-error state

**`turnErrorByChat: Record<chatKey, { code, provider }>`** — the single durable per-chat
classified-error state (replaces `errorInfoByChat`, `usageLimitReached`, `interruptedByChat`
as independent states). `chatKey` = chat id, or `DRAFT_KEY` for the not-yet-created chat.

Fed by (FR-007):
- (a) live structured error events for the chat (`handleChatError`), and
- (b) `deriveTurnError(messages)` on every transcript load / re-sync / recovery refetch /
  bfcache reload.

Rendered via `parseChatError({ code, provider })` → `{ code, provider, text }` for the
active chat only (the existing `errorInfo` selector, repointed).

**`reconnectingChatId: string | null`** — the retained transient flag (D7 / SC-005). Set
only during a non-fatal recovery attempt; subordinate to the durable banner (never
suppresses it once the attempt concludes).

**Derived selectors (pure, in `client/src/utils/chatTurnError.js`):**

- `deriveTurnError(messages) → { code, provider } | null` — the transcript source of truth
  for the banner, keyed on the **trailing turn** exactly as FR-010 / the Edge Cases demand:
  - Let `u` = index of the **last** `role === 'user'` message.
  - Return `messages[u].metadata.failure` (`{ code, provider }`) if present, else `null`.
  - This single rule gives every required behavior by construction: an interrupted partial
    (last user turn is stamped, a partial assistant follows, no newer user turn) still
    returns the record → **banner stays** (US5); a genuine later reply makes a newer,
    unstamped user turn the last one (or leaves an unstamped last user turn) → `null`; an
    older stamp deeper in the transcript is never the last user message → inert. Unknown
    codes are left to `parseChatError` at render (D6). **Do NOT neutralize on "trailing
    message is assistant with content"** — that would wrongly erase the interrupted-partial
    banner (the failure stamp, not message position, is the discriminator).
- `hasPartialReply(messages) → boolean` — true when an assistant message with visible
  content follows the last `role === 'user'` message (drives the interruption notice; only
  meaningful when `deriveTurnError` is non-null).
- `stampFailure(messages, record) → messages` — server-side helper (also unit-tested on the
  client copy for parity): applies `record` to the **last `role === 'user'` message's**
  metadata (additive). Note: for a mid-stream failure the array's last element is the
  assistant partial — the stamp still belongs on the last *user* message, **not**
  `messages[length - 1]`. No-op if there is no user message.

**Banner derivation (in the context memo / `AiChatBody`)** — from durable state **only**,
never SDK status (FR-008):

```text
transcriptError = deriveTurnError(messages)          // authoritative; self-neutralizes (see above)
liveError       = turnErrorByChat[activeKey]         // live SSE/transport events; covers the
                                                     //   pre-persist (FR-006) + pre-load window
effectiveError  = transcriptError ?? liveError
usageBanner     = effectiveError?.code === 'app_usage_limit'
interruption    = !!effectiveError && hasPartialReply(messages)
errorBanner     = !!effectiveError && !usageBanner   // usage renders its own banner
```

**Neutralization / supersession (FR-011, client-state only — never writes the stored record):**
- Supersession (FR-011a): `sendMessage` clears `turnErrorByChat[key]` (the live source);
  `transcriptError` self-clears once the new turn's unstamped user message is the last one.
- Neutralization (FR-011b): a landed reply for the chat (completed on reload, or visibly
  streaming content) clears the **live** `turnErrorByChat[key]`; `transcriptError` is already
  `null` for a genuinely answered, unstamped turn. An interrupted partial (stamped turn) is
  **not** a landed reply and is intentionally not neutralized.

## 3. Resumable stream entry (server, lifecycle change only)

Existing `activeStreams` map entry `{ chunks, done, userId }`. **Lifecycle changed** on
classified failure: torn down immediately with its buffer cleared (`teardownEntry`), so
`GET /:id/stream` returns `204` instead of replaying a failure-stripped buffer (FR-005).
Unchanged on success (30 s post-success replay window preserved).

## Entity relationships

```text
chats.messages (JSONB UIMessage[])
  └─ trailing user message
       └─ metadata.failure { code, provider, at }   ← persisted record (§1)
                 │  read on load/re-sync
                 ▼
client turnErrorByChat[chatKey] { code, provider }   ← durable state (§2)
   ├─ also fed by live SSE data-chat-error / transport error
   ├─ parseChatError → { text } → single source for every banner
   └─ neutralized/superseded by transcript position (no clearing write)
```
