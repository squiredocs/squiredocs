# Contract — Admin Shared-Model Settings Endpoint

Endpoint owned by `server/api/admin.js`. This feature changes the *effective-model semantics*
(FR-005) and makes one *additive* response change (FR-004/D2). Auth: existing admin-only guard
(unchanged). No request-body schema change.

## GET `/settings/shared-model`

Returns the shared-assistant default configuration.

**Response 200** (JSON):
```jsonc
{
  "modelKey": "or-glm-5" | null,          // stored admin selection (unchanged)
  "effectiveModelKey": "or-glm-5",         // CHANGED SEMANTICS (FR-005): the model ACTUALLY in
                                           //   effect after degradation — if modelKey's provider
                                           //   has no server key, this is the fallback
                                           //   (AI_CHAT_MODEL | claude-opus), not the stale stored key
  "models": [                              // unchanged shape; list grows with eligible entries
    { "key": "claude-opus", "label": "Claude Opus 4.8", "provider": "anthropic",
      "modelId": "…", "supportsImages": true }
    // + kimi-k3 / qwen3.7-max / qwen3.7-plus / minimax-m3 / or-glm-* when OPENROUTER_API_KEY set
  ],
  "providers": [                           // NEW (additive, FR-004/D2): eligible providers for
                                           //   <optgroup> grouping in the admin picker
    { "id": "anthropic", "label": "Anthropic" },
    { "id": "google", "label": "Google" },
    { "id": "openrouter", "label": "OpenRouter" }   // present only when OPENROUTER_API_KEY set
  ]
}
```

**Behavioral guarantees**:
- `models` includes an entry **iff** `hasServerKey(entry.provider)` is true (derived eligibility). No
  `OPENROUTER_API_KEY` → no openrouter entries, no openrouter in `providers` (SC-007 backward compat).
- `effectiveModelKey` MUST equal the key a non-BYOK chat turn would actually run on right now — the
  same `resolveSharedDefaultKey` the serving path uses (FR-005 / SC-003: degradation is visible).
- `providers` is derived from `listProviders()` filtered by `hasServerKey`; `models[i].provider`
  always matches some `providers[j].id`.

## PUT `/settings/shared-model`

Sets or clears the shared-assistant default.

**Request** (JSON): `{ "modelKey": string | null }` (unchanged; `null` clears → env/constant default).

**Validation (unchanged — derived)**:
- `modelKey !== null` and not a known `MODEL_DEFS.key` → **400** `{ error: "Unknown model: …" }`.
- `modelKey`'s provider `!hasServerKey(provider)` → **400**
  `{ error: "Model \"…\" has no shared server key and can't be the shared default" }`.
  (This is the existing gate that rejects a gateway model when `OPENROUTER_API_KEY` is absent —
  Acceptance Scenario US1-4.)

**Response 200**: identical shape to GET (same `modelKey` / `effectiveModelKey` / `models` /
`providers` semantics).

## Contract tests (to assert in `server/api/__tests__/admin.test.js`)

1. With `OPENROUTER_API_KEY` set: GET `models` includes the curated Kimi/Qwen/MiniMax + `or-glm-*`
   entries and `providers` includes `openrouter`; each `models[i].provider ∈ providers`.
2. Without the key: GET `models`/`providers` contain **no** openrouter entries (byte-for-byte today).
3. PUT a gateway `modelKey` with the key set → 200, echoes stored + effective = the gateway key.
4. PUT a gateway `modelKey` **without** the key set → 400 "no shared server key".
5. FR-005: stored `modelKey` is a gateway key but `OPENROUTER_API_KEY` absent → GET
   `effectiveModelKey` is the fallback (`AI_CHAT_MODEL` | `claude-opus`), NOT the stored gateway key.
