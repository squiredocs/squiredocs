# Promotion notes — 012-chat-error-surfacing

Merged to main 2026-07-16 (`f2865a3`), review fixes same day (`8e61c19`).
Authoritative verification on main after fixes: 158 backend suites / 2857 passed,
50 client files / 633 passed, build OK.

## Post-merge review dispositions (2026-07-16)

| Finding | Severity | Disposition |
|---|---|---|
| M1 Google RESOURCE_EXHAUSTED conflated rate-limit with billing → false operator pages via D3 | MEDIUM | FIXED in `8e61c19` — insufficient_credits only on quotaFailure/free-tier/billing bodies; bare 429/RESOURCE_EXHAUSTED → overloaded. Design doc amended (taxonomy line refined) same day. |
| M2 Mid-stream unclassified errors forwarded raw provider text (FR-009) | MEDIUM | FIXED in `8e61c19` — structured===null branch sanitizes to generic internal copy; raw text stays in server logs. |
| L3 Gemini INVALID_ARGUMENT retry dead at stream seam (pre-existing, formalized by 012) | LOW | FIXED in `8e61c19` — predicate also matches message string, mirroring isTokenLimitError. |
| L4 Reservation leak on classified "no model resolves" early return | LOW | FIXED in `8e61c19` — idempotent releaseReservation() on classified early returns after reserveCredits. |
| L5 Mid-stream fatal restored composer draft → duplicate turn on resend | LOW | FIXED in `8e61c19` — draft restore skipped on the interruption-notice (partial-reply) path; kept for pre-stream rejections (FR-018). |
| L6 internal fallback rendered raw non-JSON bodies (proxy HTML) | LOW | FIXED in `8e61c19` — server body used as display text only when genuinely structured JSON. |

## Owed at/after promotion

- **Browser E2E (T041/quickstart.md)**: live-browser pass over the seven error
  classes in both surfaces — owed by Sam, consistent with features 005–007.
- **Deploy**: prod still runs the pre-012 error behavior until Sam triggers deploy.
- **D3 ratification (Sam's eye wanted)**: shared-server-key billing exhaustion is
  surfaced to users as `provider_overloaded` (they can't fix operator billing) while
  the operator notification carries the true cause. A dedicated user-facing code
  would need a design-doc amendment.
- **D5**: interruption notices are session-scoped, not persisted — if truncation
  evidence should survive reloads, that's a design amendment.
- **D9**: mid-stream code/provider ride a transient `data-chat-error` part (AI SDK
  strict-validates the error part shape); revisit if the SDK ever allows extra
  fields on error parts.

## Decisions ledger

D1–D9 in `clarifications-needed.md`, all RATIFIED-BY-DEFAULT (Sam pre-authorized,
2026-07-16). D3 and D5 are the two worth Sam's explicit confirmation.
