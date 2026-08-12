# Contract: bindState completeness & refusal (FR-003, FR-004, RBD-057-3/4)

Surface: `createBindState` (server/collab-bind-state.js) + `refuseBind`
(server/bind-failure.js) + `collab.bind.refusals` counter.

## Guarantees

1. **Capture-then-fetch**: the expected tail clock is captured from the log
   *before* the row fetch (`getClockRange`); the load is judged against it.
2. **Opt-in detection**: the bind-time `getYDoc` runs with `withGap: true`
   and `expectedTailClock`, so both interior gaps and short reads are
   detected by the existing 021/039 choke point with the existing in-call
   retry budget (`COLLAB_READ_GAP_RETRIES` defaults unchanged).
3. **Refuse, don't memoize**: a load still incomplete after the budget is
   refused via `refuseBind`: doc marked `_bindFailed`, evicted (identity-
   checked), connections closed 1013 (clients retry with existing backoff),
   doc destroyed when provably out of the registry. `_bindComplete` and
   `_verifiedClock` are never set on that instance.
4. **Trust flag semantics**: `_bindComplete` is only ever set over a
   verified-complete load, after the state is applied, with
   `_verifiedClock` = captured tail. `isTrustedLiveDoc` consumers unchanged.
5. **Typed reasons**: refusals carry `reason: 'load-error'` (041 behavior,
   byte-identical paths) or `'incomplete-load'` (new). The counter records
   the reason label.
6. **Paging posture** (RBD-057-3/4): `load-error` pages exactly as today
   (first occurrence, per-doc throttle). `incomplete-load` does **not** page
   on first occurrence; a repeat for the same doc within the throttle window
   pages through the existing per-doc throttle — so a persistent gap
   (damaged log, RBD-057-4) fails closed *and* reaches a human, while a
   benign lost race costs one retry and one counter increment.
7. **Legitimate emptiness**: zero rows ⇒ no tail check ⇒ empty bind
   completes normally (`_verifiedClock` = -1), no refusal.

## Test obligations

- US3 acceptance 1–4 (gapped-past-budget, short read, heals-within-budget,
  new doc). SC-004 (100% of injected incomplete loads refused; none
  memoized/trusted).
- Paging: first incomplete-load refusal pages nobody; repeat within window
  pages once; load-error paging unchanged (041 suite stays green).
- Counter reason labels assert via telemetry-capture harness.
