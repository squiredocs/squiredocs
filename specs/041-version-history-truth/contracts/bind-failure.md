# Contract: Collaboration Bind Failure Semantics (FR-010)

## Server (bindState, server/index.js)

| Situation | Behavior |
|---|---|
| Load succeeds, rows exist | Bind normally (unchanged). |
| Load succeeds, zero rows (genuinely new doc) | Bind normally as empty doc (unchanged — `persistence.getYDoc` does NOT throw for no rows; pin-tested). |
| Load THROWS (DB outage, query failure) | **Refuse the bind**: (1) `notifyException(error, { source: 'bindState', extra: { docGuid } })`; (2) error-level log — NEVER the info-level `NEW DOC` line; (3) mark `ydoc._bindFailed = true`; (4) evict the doc from the y-websocket `docs` map; (5) close every connection on the doc with close code **1013** (Try Again Later). No empty doc remains reachable; the update listener drops persists while `_bindFailed`. |

## Client (y-websocket WebsocketProvider / useYjs)

- 1013 is NOT in the fatal auth set (4401/4403), so the provider auto-reconnects
  with its own backoff. Each retry re-creates the doc (evicted map entry) and
  re-attempts the load; the outage window looks like "connecting", never like an
  empty document.
- A client holding local IndexedDB state never gets a server SyncStep1 computed
  from a falsely-empty doc, so it cannot re-supply the whole document as its own
  new edits (the attribution-corruption vector this closes).

## Outage behavior

- Repeated failures: one refused bind per reconnect attempt, throttled by the
  provider's backoff; notifier dedupe follows its existing conventions. No
  crash loop: the refusal path allocates nothing persistent.
- Recovery: first successful load after the outage binds normally; no state to
  clean up.

## Observability
- Success path unchanged. Failure path emits exactly: 1 exception notification
  (per notifier dedupe), ≥1 error log line with docGuid, 0 `NEW DOC` /
  `BIND_STATE_NEW_DOC` events (SC-004: those now imply a genuinely new doc).
