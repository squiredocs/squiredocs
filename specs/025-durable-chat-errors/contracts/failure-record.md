# Contract — Turn Failure Record & Derived Banners

This feature adds **no new HTTP endpoint**. The contracts here are (A) the persisted
metadata shape carried inside existing chat responses, (B) the unchanged live error
channels, and (C) the server-side behavioral invariants the tests assert.

---

## A. Persisted failure record (inside existing chat load responses)

`GET /api/chat/:id` (and every path that returns `chats.messages`) may now include, on the
trailing user message of a failed turn:

```jsonc
{
  "role": "user",
  "parts": [ /* ... */ ],
  "metadata": {
    "failure": { "code": "provider_overloaded", "provider": "anthropic", "at": "2026-07-21T16:20:00.000Z" }
    // ...any pre-existing metadata (refs, kind) preserved
  }
}
```

Contract invariants:
- `metadata.failure` is present **iff** the turn was classified as failed and its user
  message was persisted (FR-002). Pre-save rejections carry no record (FR-006).
- `failure.code` ∈ taxonomy codes; `failure.provider` optional; `failure.at` ISO 8601.
- **No** `error`/raw-text field ever appears (FR-003).
- Additive only: consumers that ignore `metadata` (model-history assembly, legacy clients)
  are unaffected (FR-016).

## B. Live error channels (UNCHANGED — reused as-is)

- **Pre-content**: HTTP JSON `{ error, code, provider? }` with honest status (402/429/4xx),
  from `buildErrorPayload` / `sendClassifiedError`. Unchanged.
- **Mid-stream**: transient `data-chat-error` SSE part `{ code, provider? }` immediately
  followed by the `error` SSE event (sanitized text). Unchanged (`chat.js:389-394`).

The client feeds both into the same durable `turnErrorByChat` state (FR-007).

## C. Server behavioral invariants (asserted by tests)

1. **Stamp durability (FR-004)** — after a classified failure, `loadChat` returns a
   transcript whose trailing user message carries `metadata.failure`, for:
   - a mid-stream failure that also persisted a partial assistant reply (stamp-aware
     `onFinish` save — one write carries both);
   - a post-save early return (usage-limit / byok-misconfigured / no-model / image-
     unsupported) — awaited RMW stamp;
   - a before-content outer-catch failure — awaited RMW stamp.
2. **No stamp before persistence (FR-006)** — a per-user stream-cap rejection (returns
   before the user-message save) leaves **no** `metadata.failure` and does not mutate any
   prior turn.
3. **Immediate teardown / no failure replay (FR-005)** — after a classified failure,
   `GET /api/chat/:id/stream` returns `204` (entry gone, buffer cleared); it never replays a
   clean-looking buffer. The **post-success** replay window (30 s) is unchanged.
4. **Codes only (FR-003)** — the persisted record contains exactly `{ code, provider?, at }`;
   no raw provider text.
5. **Success path unchanged** — a normal successful turn persists no `failure` and keeps the
   30 s replay window; byte-for-byte behavior preserved.

## D. Client behavioral invariants (asserted by tests, FR-017)

1. A durable banner set from a live error **stays** across `error → submitted`(error
   cleared) and a clean replay ending at `ready` (SDK status is never a render gate).
2. A transcript bearing `metadata.failure` on its trailing user turn **populates** the
   banner on load, with identical copy/action to the live-session banner (same code).
3. A failed recovery (resume opens a connection, no reply lands) **leaves** the banner.
4. The next send **clears** the banner immediately; a landed assistant reply
   (completed or streaming content) **neutralizes** it with no clearing write.
5. Consolidation: exactly one durable per-chat state + the transient reconnecting flag;
   usage-limit and interruption banners are derivations (SC-005), with zero change in
   rendered copy/action per code (FR-013).
