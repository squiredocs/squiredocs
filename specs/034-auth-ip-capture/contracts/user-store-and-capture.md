# Contract: capture extraction, user-store helpers, and the event writer

**Feature**: 034-auth-ip-capture | Internal module contracts (server-side, CommonJS).

All three modules live under `server/auth/`. Every signature below is **backward compatible**: the new arguments are optional and omitting them reproduces today's behavior with `NULL` capture, so existing callers and existing tests keep passing unchanged (assignment constraint).

---

## C1 — `server/auth/auth-context.js` (NEW)

The **single** place a request is turned into a capture pair. Nothing else in the codebase may derive `{ ip, userAgent }` for storage.

```js
/**
 * @param {import('express').Request} req
 * @returns {{ ip: string|null, userAgent: string|null }}
 */
function authContext(req)

module.exports = { authContext, MAX_USER_AGENT_LENGTH /* = 512 */ };
```

**Behavior**

| Condition | `ip` | `userAgent` |
|-----------|------|-------------|
| Normal browser request behind the configured proxy hops | `req.ip` verbatim (e.g. `203.0.113.7`, `2001:db8::1`, `::ffff:127.0.0.1`) | the header, trimmed |
| `req.ip` absent | falls back to `req.socket?.remoteAddress` | — |
| Resolved value fails `net.isIP()` (missing, `''`, `'unknown'`, `fe80::1%eth0`) | `null` | — |
| `User-Agent` header absent or empty after trim | — | `null` |
| `User-Agent` longer than 512 chars | — | first 512 chars exactly (FR-007) |
| `req` is `null`/`undefined` or malformed | `null` | `null` (never throws) |

**Invariants**

- Pure and synchronous. No I/O, no database, no logging. Unit-testable with a plain object literal.
- MUST NOT read `X-Forwarded-For` directly. The address comes from Express's `req.ip`, which is only trustworthy because `trust proxy` is a fixed numeric hop count (FR-006). Reading the header directly would reintroduce exactly the spoofing hole the numeric setting exists to close.
- MUST NOT return the string `'unknown'` (the `server/rate-limit.js` `clientIp()` bucket-key fallback) — that value is not a valid `inet` literal.

---

## C2 — `server/auth/users.js` (EXTENDED — two signatures)

### `findOrCreateUser(profile, options)`

```js
async function findOrCreateUser(
  { googleId, email, name, picture },
  { signupSource = 'browser', ip = null, userAgent = null } = {}
) // → Promise<user & { isNew: boolean }>
```

| Change | Contract |
|--------|----------|
| New options `ip`, `userAgent` | Written to `signup_ip` / `signup_user_agent` **only in the INSERT column list**. MUST NOT appear in the `ON CONFLICT DO UPDATE SET` clause (FR-001). |
| Returning user | Signup columns are untouched, whatever the passed context. Verified by test. |
| Options omitted | Inserts `NULL, NULL`. No throw, no warning. |
| Return value | Unchanged shape (`isNew` still derived from `xmax = 0`). |
| Events | Appends **nothing** to `auth_events` (research R1). |

### `updateLastLogin(userId, context)`

```js
async function updateLastLogin(
  userId,
  { ip = null, userAgent = null, signupSource = 'browser', isNew = false } = {}
) // → Promise<void>
```

| Change | Contract |
|--------|----------|
| Snapshot | One statement: `UPDATE users SET last_login_at = now(), last_login_ip = $2, last_login_user_agent = $3 WHERE id = $1` (FR-002). No extra round trip. |
| Trail | Appends **exactly one** `auth_events` row per call: `event = isNew ? 'signup' : 'login'`, carrying `userId`, `signupSource`, `ip`, `userAgent` (FR-003). |
| Failure isolation | The `auth_events` write is delegated to `authEvents.record(...)`, which never throws (C3). A trail failure MUST NOT prevent the `users` update or the caller's success path (FR-008). |
| Context omitted | Updates the timestamp and sets both capture columns to `NULL`; appends a `login` row with `NULL` capture and `signup_source='browser'`. Existing callers/tests keep working. |
| Ordering | Snapshot update first, event append second. If the snapshot throws (a real DB fault), the caller's error path is unchanged from today. |

### `init(pool)`

Also initializes the event writer (`authEvents.init(pool)`) so every existing init path — app boot and every test that calls `users.init(pool)` — wires the trail with the same pool. No new init call site.

---

## C3 — `server/auth/auth-events.js` (NEW)

```js
function init(pool)

/**
 * Append one immutable trail row. NEVER throws.
 * @returns {Promise<boolean>} true if the row landed, false if it was swallowed
 */
async function record({ userId, event, signupSource, ip, userAgent })

/** @returns {Promise<number>} rows deleted */
async function purgeOlderThan(days = 180)

/** Boot sweep + daily interval. Idempotent; the timer is unref()'d. */
function startPurgeJob({ intervalMs = 86_400_000, days = 180 } = {})

/** clearInterval; safe to call when not started. */
function stopPurgeJob()

module.exports = { init, record, purgeOlderThan, startPurgeJob, stopPurgeJob, RETENTION_DAYS /* = 180 */ };
```

**`record` contract**

- `INSERT INTO auth_events (user_id, event, signup_source, ip, user_agent) VALUES ($1,$2,$3,$4,$5)` — parameterized, one statement, no transaction.
- Wrapped in `try/catch`. On **any** failure (uninitialized pool, connection loss, constraint violation, invalid `event` value) it logs via `console.error` with a stable `[AuthEvents]` prefix and returns `false`. It MUST NOT rethrow, MUST NOT reject, and MUST NOT be `await`ed in a way that can surface a rejection to the auth flow (FR-008, SC-003).
- `event` is guarded to the `'signup' | 'login'` domain and `signupSource` to `'browser' | 'agent_oauth'` before binding, mirroring how `findOrCreateUser` guards `signup_source` today — a bad value becomes the safe default rather than a `CHECK` violation.
- Append-only: this module exposes no update and no per-row delete. `purgeOlderThan` is the sole delete path (plus FK cascade).

**`purgeOlderThan` contract**

- `DELETE FROM auth_events WHERE created_at < now() - ($1 || ' days')::interval`, returning `rowCount`.
- Touches **only** `auth_events`. MUST NOT reference `users` (FR-010: per-account fields are exempt from retention).
- Rejects on DB error — its callers (the boot sweep and the interval) catch and log; it is never on an auth path.

**`startPurgeJob` contract**

- One immediate sweep (fire-and-forget, errors logged) then `setInterval(...).unref()`.
- Calling it twice does not create a second timer.
- Safe with multiple replicas: the `DELETE` is set-based and idempotent.

---

## C4 — Call sites (`server/auth/routes.js`) — no logic change

Exactly three pairs, all post-verification. Each gains the same two-line shape:

```js
const ctx = authContext(req);
const user = await findOrCreateUser(profile, { signupSource, ...ctx });
await updateLastLogin(user.id, { ...ctx, signupSource, isNew: user.isNew });
```

| Line (pre-change) | Path | `signupSource` |
|-------------------|------|----------------|
| `:311` / `:322` (`completePostAuth`) | Browser OAuth **and** agent OAuth (derived from a valid `returnTo`) | already computed in scope |
| `:606` / `:612` | dev-login, legacy fixed user (`dev@test.local`) | `'browser'` (its current implicit default) |
| `:668` / `:669` | dev-login, fresh JSON mode | `'browser'` (already explicit) |

### C4a — `completePostAuth` MUST NOT receive `req` (feature 031 invariant U2 / INV-3)

`completePostAuth(res, { profile, clientUrl, rawReturnTo })` deliberately has **no** `req` parameter. The comment above `tryParseAuthorizeReturnTo` (`server/auth/routes.js:232-236`) states the reason: it "NEVER reads `req.query` / `req.body` / headers — `completePostAuth` does not even receive `req`, so the auto-issue parameters cannot originate from any client-modifiable post-auth channel (INV-3 / structural invariant U2)". That is a security-reviewed, ratified invariant of feature 031's inline auto-issue path.

**Therefore**: `completePostAuth` gains a **`ctx`** parameter — the already-extracted `{ ip, userAgent }` pair — and never a `req`:

```js
async function completePostAuth(res, { profile, clientUrl, rawReturnTo, ctx = { ip: null, userAgent: null } })
```

Both callers (`:220` the Google callback, `:664` dev-login fresh-browser mode) compute `authContext(req)` in their own scope, where `req` legitimately lives, and pass the resulting two scalars. `completePostAuth` receives storage-only values it never interprets, so U2 holds unchanged: there is still no client-modifiable channel into the auto-issue parameters. This is the only structural change permitted in `routes.js`.

**Not touched**: the token-refresh route (FR-005 — it calls neither helper), JWT issuance, cookie options, the OAuth handshake, `requireAuth`/`requireAdmin`.

---

## C5 — Boot and shutdown wiring

| File | Change |
|------|--------|
| `server/index.js` | After the existing users/pool init: `authEvents.startPurgeJob()`. In the `createShutdown({...})` call: add `stopBackgroundJobs: authEvents.stopPurgeJob`. |
| `server/shutdown.js` | Accept an **optional** `stopBackgroundJobs` dep and invoke it inside the existing guarded-step pattern (`if (typeof stopBackgroundJobs === 'function') { try { stopBackgroundJobs(); } catch {} }`) before the async drain steps. Absent → no-op, so every existing `createShutdown` test is unaffected. |

The `.unref()`ed timer means correctness does not depend on this wiring; the hook exists so the drain is explicit and testable (lifecycle convention).
