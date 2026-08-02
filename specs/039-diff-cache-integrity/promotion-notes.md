# 039-diff-cache-integrity — promotion notes & review dispositions

Post-merge adversarial review, 2026-08-01. Feature commits `61a387af`,
`30dd26d8`, `75a95368`; merge-base `b6532480` (038 merged in between, so
`git diff main` is misleading — review used the three commits directly).
Docs follow-up `e448a579`.

## Review outcome: no HIGH, no MEDIUM

The reviewer verified by **execution**, not inspection — provoking a real jsdiff
timeout followed by a size cap against the same report sink, running the
re-split against adversarial inputs, and building an old-vs-new replay oracle
over both linear and concurrent-origin Yjs logs with cross-boundary deletions.
That method is what caught the varint bypass in 038, and it was used here
deliberately.

Confirmed sound: the sticky degradation flag (the cache gate reads the
accumulating `timedOut`, never the per-call `reason`; a later size-capped region
cannot erase an earlier timeout); the tail check being genuinely opt-in (the
diff service is the only caller — the backfill's MAX_CLOCK sentinel does not opt
in and pays no retries); `gapped`'s widened meaning being invisible to the four
other read-path consumers; byte-identical per-row rejoin across empty rows,
whitespace-only rows, multi-row segments, and multi-byte/ZWJ emoji, with a
content newline failing open to row tint rather than silently misaligning;
`inlineSegments` unreachable on all three model seams while the browser copy
keeps them (stripping is projection, not mutation — asserted at runtime);
`convertToModelMessages` still called with exactly one argument; and the seeded
single replay producing identical XML and state vectors to the old double replay
under concurrent origins and cross-tombstone deletes.

## LOW — oversized-result veto measured a payload nobody receives — FIXED (`0fbac295`)

**Finding.** `chat-tools.js` gated on `JSON.stringify(result).length` using the
**unstripped** result, but post-039 the model receives the stripped copy. A
diff-heavy `modify` could be rejected with "exceeds available context" for bytes
the model never sees — costing the user their diff card and handing the model
remediation advice ("page the document with xpath") that cannot apply to word
segments.

**Fix.** Measure the model-bound projection.

**This reversed a deliberate decision, not an oversight.** The 039 implementer had
written MB-3 to pin the old behavior, reasoning that the cap protects what is
stored and rendered as well as what the model sees. That rationale lost to the
guard's own definition: it is declared a context cap ("Reactive compaction
handles overall context"), its error names the context window explicitly, and
its remediation is document paging. MB-3 was rewritten with the reasoning
recorded in-test so the reversal is legible rather than looking like drift.

**The underlying concern was real and is now unowned — see below.**

## Owed / follow-on

1. **Nothing budgets the STORED or RENDERED size of a tool result.** This is the
   valid half of the implementer's MB-3 reasoning, separated from the mechanism
   it was wrongly attached to. A result can now be arbitrarily large in the
   database and in the browser payload as long as its model-bound projection
   fits. If that needs a limit it needs its own constant and its own error
   message — folding it back into the context guard would recreate exactly the
   confusion that was just fixed.
2. **Manual smoke owed (Sam)**: word emphasis in light and dark themes on a real
   version pair; an in-app agent `modify` showing surplus-row emphasis (the
   visible behavior change Sam approved); and confirming no `diffv9:` key is
   read after deploy (the v10 bump should make them all cold).

## Notes for future work in this area

- **`npx jest` never exits on this repo** (a Redis client stays connected), so a
  bare invocation hangs and, when piped, returns nothing at all — which reads as
  a broken run rather than a finished one. Cost ~20 minutes of implementer time.
  Now documented in `docs/dev.md` along with the serial-only database rule.
- **The analyze stage cited two test files that do not exist** (`server/diff/__tests__/`
  and `server/api/__tests__/chat-tools.test.js`). The implementer discovered the
  chat-tools suite actually lives at `server/__tests__/chat-tools.test.js` with a
  working harness, and retargeted rather than building a duplicate. Worth
  remembering that "add a test to X" instructions deserve an existence check.
- **The truncation-filter fixture had to be reshaped, not just re-asserted.** Under
  region-level segmentation its 260 consecutive changed rows join into one ~49k
  region that trips the size guardrail, which would have silently stopped
  exercising the filter. Interleaving context lines keeps each region small so
  the filter is genuinely tested. A fixture that still passes is not proof it
  still tests anything.
