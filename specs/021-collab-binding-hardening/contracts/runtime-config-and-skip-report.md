# Contract: Runtime Config (kill-switch) & Render-Skip Report Endpoints

Two small endpoints in `server/index.js` + one admin settings pair in `server/api/admin.js`.
Trust boundaries stated per Constitution V.

## `GET /api/client-config` (requireAuth)

- Response: `{ collabBindingHardening: boolean }` — `false` only when
  `appSettings.getSetting('collab_binding_hardening') === 'false'`; otherwise `true`
  (absent = default ON, DR-2).
- Client: fetched once at app bootstrap (`client/src/hooks/useClientConfig.js`, AuthContext
  axios instance); sets `globalThis.__SQUIRE_COLLAB_HARDENING__`. Fetch failure ⇒ global
  left unset ⇒ hardened (fail-safe default ON). Flip semantics: at most a page refresh
  (patch reads the global live, so open tabs may pick it up sooner — bonus, not contract).
- Trust boundary: authenticated read of a server-owned boolean; no user input.

## `GET|PUT /api/admin/settings/collab-binding-hardening` (requireAdmin — mounted under `/api/admin`)

- Follows the existing `settings/shared-model` pattern in `server/api/admin.js`.
- `PUT` body `{ enabled: boolean }` → `appSettings.setSetting('collab_binding_hardening',
  enabled ? null : 'false')` (unset = ON keeps the default-ON invariant literal in the
  store); write-through cache makes the flip immediate, no restart.
- `GET` returns `{ enabled: boolean }`.

## `POST /api/collab/render-skip-report` (requireAuth)

- Purpose (DR-3): render-skip/stand-in events observable server-side within minutes —
  divergence classes 2/3 (invalid composites, mixed-version clients) must never be
  anecdote-discovered.
- Request body (JSON, **≤ 8 KB**, shape-validated; reject 400 otherwise):

```json
{
  "docId": "<doc guid>",
  "bindingVersion": "3.0.7+squire021",
  "events": [ { "nodeType": "string ≤64", "errorName": "string ≤64", "count": 1 } ]
}
```

  Max 20 events per report. Fields are node type names / error class names / counts —
  **never document content, text, or attributes** (content-free by construction).
- Server behavior: `204`; emit one structured log line per report
  (`[CollabSkipReport] doc=<guid> user=<id> events=[…] bindingVersion=…`) and increment
  OTel counter `collab.render_skip.reports` (attributes: `nodeType`, `errorName`) via the
  feature-014 metrics spine (`server/telemetry/metrics.js`) — rides existing o11y alerting.
- Trust boundary: untrusted client input — auth required, size-capped, schema-validated,
  rate-limited via the existing `server/rate-limit.js` limiter classes; malformed input is
  rejected without side effects; the report never mutates document state.
- Client reporter (`client/src/utils/skipReporter.js`): deduplicated by the once-per-element
  rule (RBD-6), debounced 2 s, batched per document, fire-and-forget (failures swallowed —
  never affects editing). Exposed to the patch via `globalThis.__SQUIRE_SKIP_REPORTER__` at
  bootstrap (no app-code import edges in the patch). Operates regardless of kill-switch
  state (flag OFF ⇒ stock behavior produces no skip events, but the channel stays live).
- Test obligation: a forced skip produces **exactly one** report per element per binding
  instance (client test with mocked transport).
