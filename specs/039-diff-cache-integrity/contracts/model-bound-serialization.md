# Contract — Model-bound serialization hygiene (FR-012 … FR-014)

UI-only word-emphasis data (`diff.inlineSegments`) MUST NOT reach the model on any path, while
storage and the browser keep it.

---

## `stripUiOnlyDiffFields(toolResult)` — NEW shared helper

Exported from `server/mcp/diff-utils.js` (beside `computeChatDiff`, whose output it strips).

```
stripUiOnlyDiffFields(result: unknown) → unknown
```

### Guarantees

- **ST-1 — Pure and non-mutating.** Never modifies its argument. Load-bearing: at two of the three
  seams the same object is also the persisted / browser-bound copy (FR-013).
- **ST-2 — Identity when nothing to strip.** Returns the argument unchanged (same reference) when
  it is not an object, has no `diff`, or `diff.inlineSegments` is absent.
- **ST-3 — Targeted.** Removes exactly `result.diff.inlineSegments`. Returns a shallow clone of
  `result` with `diff` shallow-cloned minus that key.
- **ST-4 — Retains model-useful data.** `diff.lines`, `diff.hunkStarts`, `diff.formatAnnotations`,
  and `diff.truncatedByServer` are kept (FR-012).
- **ST-5 — Not a deep walk.** All three producers (`modify`, `undo`, `redo`) attach the diff at
  `result.diff`; a generic deep key-removal would be over-broad and slow.

---

## Seam (a) — MCP tool result

**Location**: `server/mcp/index.js:69` —
`return [{ type: 'text', text: JSON.stringify(result, null, 2) }];`

**Change**: `JSON.stringify(stripUiOnlyDiffFields(result), null, 2)`.

- **MA-1** The pretty-print indentation is **unchanged** (explicit spec non-goal).
- **MA-2** Applies uniformly to every MCP tool result; tools without a `diff` are pass-through by
  ST-2.

---

## Seam (b) — Live in-app chat turn

**Location**: `server/api/chat-tools.js`, `buildTools`, the MCP-bridge `tool({ ... })` at ~line 467.

**Change**: add

```js
toModelOutput: ({ output }) => ({ type: 'json', value: stripUiOnlyDiffFields(output) }),
```

- **MB-1** The value returned by `execute` (which the AI SDK persists and the browser renders)
  keeps `inlineSegments` — only the model-bound projection is stripped (FR-013).
- **MB-2** The image tools' own `toModelOutput` definitions (`chat-tools.js:321`, `:386`) are
  **not** modified; they are separate tool definitions built outside this loop.
- **MB-3** `MAX_RESULT_CHARS` (line 501) continues to measure the **full** result — it guards what
  is stored and rendered, not only what the model sees. Out of scope to change.
- **MB-4** Adding `toModelOutput` to the bridged tools MUST NOT change behavior for tools whose
  results carry no `diff` (ST-2 identity).

---

## Seam (c) — Replayed conversation history

**Location**: new `stripUiOnlyDiffParts(messages)` in `server/api/chat-models.js`; called in
`server/api/chat.js` beside `stripReasoningParts` (~line 964), **before**
`convertToModelMessages` (~line 976).

```
stripUiOnlyDiffParts(messages: UIMessage[]) → UIMessage[]
```

- **MC-1 — Dedicated pass (FR-014).** Implemented as its own pass over stored message parts,
  modeled on `stripReasoningParts` (`chat-models.js:312`): input array and parts are **not**
  mutated; a new array is returned.
- **MC-2 — `convertToModelMessages` gets NO `tools` argument.** This is the load-bearing negative
  requirement (FR-014, hazard #2): `view_image` and `view_svg_blocks` define `toModelOutput`
  precisely to ADD image bytes that stored history deliberately omits
  (`chat-tools.js:312`, `:321`, `:370`, `:386`). Passing tools into the history conversion would
  re-inline every image on every turn and can 404 a text-only model. **A code comment at the call
  site MUST record this** so the "simplification" is never attempted.
- **MC-3 — Scope.** Rewrites only tool parts whose `output.diff.inlineSegments` exists, via
  `stripUiOnlyDiffFields`. Unlike `stripReasoningParts`, it never drops a part or a message —
  it only shrinks an output.
- **MC-4 — Unconditional.** Runs for every provider (unlike `stripProviderExecutedTools` /
  `stripReasoningParts`, which are capability-gated). The data is useless to every model.
- **MC-5 — Storage untouched.** `validatedMessages` (persisted history + UI) keeps the segments;
  only `modelInputMessages` is rewritten, matching the established pattern at
  `chat.js:959-975`.

---

## Test obligations

| ID | Assertion |
|---|---|
| MS-1 | `stripUiOnlyDiffFields` removes `diff.inlineSegments` and retains `lines`, `hunkStarts`, `formatAnnotations`, `truncatedByServer`. |
| MS-2 | Input object is not mutated; unrelated results are returned by identity. |
| MS-3 | MCP serialization of a `modify` result contains no `inlineSegments`; indentation unchanged. |
| MS-4 | The chat tool's `toModelOutput` strips, while the value returned by `execute` still carries the segments. |
| MS-5 | `stripUiOnlyDiffParts` over a stored history containing a past `modify` result strips the segments; input array and parts unmutated. |
| MS-6 | An image tool part in history survives the strip pass **without** image bytes being re-inlined (the FR-014 regression guard). |
| MS-7 | `convertToModelMessages` is invoked with exactly one argument (guards against the forbidden `{ tools }` shortcut). |
| MS-8 | Round-trip: browser-bound / persisted output still renders word emphasis (existing `AiChatMessages` test passes unmodified). |
