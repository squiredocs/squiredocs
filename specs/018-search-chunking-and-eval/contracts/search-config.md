# Contract: Shared Search-Configuration Surface (FR-026)

`server/search/config.js` — the ONE place that resolves search-pipeline knobs.
The indexer, `search.js`, and the eval harness all call `getSearchConfig(overrides)`;
the harness's `overrides` express variants, so an evaluated variant is exactly
reproducible as a shipped configuration.

## Resolution

`getSearchConfig(overrides = {})` → env var → default, per knob. Overrides win.

| Knob | Env | Default | Consumer | Notes |
|---|---|---|---|---|
| `chunking` | — | `'structure'` | indexer (via eval override only) | `'fixed'` reproduces the pre-018 window chunker for the baseline variant (D12); not exposed as env — the live pipeline is always `structure` |
| `preambles` | `SEARCH_PREAMBLES` | `true` | indexer | off ⇒ zero contextualizer calls corpus-wide |
| `rerank` | `SEARCH_RERANK` | `false` | search.js | FR-030: off by default; flag-only |
| `chunkTargetTokens` | `SEARCH_CHUNK_TOKENS` | `600` | chunker | RBD-1 |
| `headingFillRatio` | — | `0.5` | chunker | RBD-1; override-only |
| `overlapRatio` | — | `0.12` | chunker | RBD-1; override-only |
| `distanceThreshold` | — (existing request option) | `0.5` | search.js | unchanged from today |

- Boolean env parsing: `1|true|on|yes` (case-insensitive) = true.
- Determinism (FR-006) holds for every knob combination.
- Adding a knob = adding it here + to the eval sweep surface; no other file may
  read these env vars directly.
