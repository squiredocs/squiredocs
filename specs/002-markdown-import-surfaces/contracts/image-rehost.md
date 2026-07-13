# Contract: SSRF-Safe Image Fetch-and-Rehost

Module: `server/image-rehost.js`. The **only network egress this feature introduces** (spec Trust Boundary). Consumed by the import module's post-materialization pass and by modify's post-script pass for `fromMarkdown`-tagged nodes (FR-021, research R3). Bytes are stored via the existing `documentImages.storeImage` path (existing 15 MB cap + png/jpeg/gif/webp allowlist, attribution to the acting user — FR-016, research R5).

## Public surface

```js
/**
 * Rehost external http(s) image srcs found on the given image nodes.
 * Mutates node srcs in place (external → app URL) or degrades the node to a
 * plain link. Never throws for per-image failures; returns the itemized report.
 * @param {Y.XmlFragment|Y.XmlElement[]} target - fragment or just-imported nodes
 * @param {{ docId: string, userId: string }} ctx
 * @returns {Promise<ImageReport>} (see data-model.md §5)
 */
async function rehostImagesInFragment(target, ctx)

/** Testable core: fetch one URL under the full SSRF policy. */
async function safeFetchImage(url, { maxBytes, timeoutMs, maxRedirects }) // → { data: Buffer, mimeType } | throws PolicyError(reason)
```

`PolicyError.reason` is a stable string: `blocked-address` | `bad-scheme` | `too-many-redirects` | `timeout` | `too-large` | `bad-content-type` | `network-error`. The pass-level report additionally uses the reasons `budget-exhausted` (20-unique count budget), `time-budget-exhausted` (aggregate wall-clock budget), `storage-disabled`, and `data-url`, which are produced by `rehostImagesInFragment` itself rather than by a per-fetch `PolicyError`.

## Fetch policy (CN-7 / FR-017) — normative

1. **Scheme**: `http:` and `https:` only. Everything else (`ftp:`, `file:`, `data:`…) is rejected without any I/O.
2. **Address validation, every hop**: before each connection (initial request and every redirect), resolve the hostname and validate **all** candidate addresses. Blocked (reject if ANY candidate is non-global):
   - IPv4: `0.0.0.0/8` (unspecified), `10.0.0.0/8`, `100.64.0.0/10` (CGNAT), `127.0.0.0/8`, `169.254.0.0/16` (link-local incl. `169.254.169.254` metadata), `172.16.0.0/12`, `192.168.0.0/16`, `224.0.0.0/4` (multicast), `240.0.0.0/4`, `255.255.255.255`.
   - IPv6: `::` , `::1`, `fe80::/10` (link-local), `fc00::/7` (unique-local), `ff00::/8` (multicast), `64:ff9b::/96` (NAT64 of blocked v4), and **IPv4-mapped** `::ffff:a.b.c.d` re-checked as IPv4.
   - Hostnames that are literal IPs are validated directly (including exotic encodings — octal/hex/integer literals must not bypass; parse with `net.isIP` after URL normalization).
3. **Connection pinning (no DNS-rebind window)**: the socket MUST connect to the exact IP that passed validation (resolve once, validate, connect to that address with the original hostname used only for SNI/Host header). A second resolution between check and connect is forbidden.
4. **Redirects**: max 3 hops (301/302/303/307/308). Each hop's URL re-runs steps 1–3. Cross-scheme https→http allowed (still validated); anything else non-http(s) → reject.
5. **Timeout**: 10 s wall clock per fetch (connect + headers + body). Enforced with an abort, not a passive timer.
   - **Aggregate pass budget**: the whole image pass runs under a default **30 s** wall-clock budget (configurable via the `budgetMs` option / `IMPORT_IMAGE_PASS_BUDGET_MS` env). When it expires, every in-flight fetch is aborted (via the shared budget `AbortSignal`, which composes with — and never weakens — the per-fetch timeout) and every not-yet-rehosted image degrades to a plain link with reason `time-budget-exhausted`.
6. **Size**: enforce the existing image cap (`documentImages.MAX_IMAGE_BYTES` = 15 MB) **while streaming** — abort the moment the received byte count exceeds the cap; also reject early on a `Content-Length` header over the cap. Never buffer more than the cap.
7. **Content type**: response `Content-Type` must be in `documentImages.ALLOWED_IMAGE_MIME_TYPES` (png/jpeg/gif/webp). (Parameters like `; charset=` stripped before comparison.) `storeImage` re-validates as defense in depth.
8. **Budget**: at most **20 unique external URLs fetched per import**; identical URLs (after normalization) deduplicate to one fetch and one stored copy shared by all referencing nodes (FR-018, US4-AS6). Excess unique URLs beyond 20 degrade with reason `budget-exhausted`. Fetches run with **bounded concurrency = 4** (hand-rolled worker pool, no new dependency; the per-fetch SSRF validation + connection pinning is fully per-call with no cross-fetch shared mutable state, so it holds under concurrency). This count budget is orthogonal to the aggregate wall-clock budget in §5.
9. **No credentials**: no cookies, no auth headers, no proxy env honored for these fetches; a fixed innocuous `User-Agent`; never forward the caller's authorization.

## Degradation (never fail the import — FR-018/019)

| Case | Node outcome | Report |
| --- | --- | --- |
| Any PolicyError on an external URL | plain link: text = alt \|\| URL, href = original URL | `degraded[{src, reason}]` |
| Count budget exhausted (>20 unique URLs) | same plain-link degradation | `degraded`, reason `budget-exhausted` |
| Time budget exhausted (aggregate deadline hit; in-flight fetches aborted) | same plain-link degradation | `degraded`, reason `time-budget-exhausted` |
| `s3Images.isEnabled() === false` | all externals degrade (no fetch attempted) | `degraded`, reason `storage-disabled` |
| `data:` src | alt text as plain text; node dropped entirely when alt empty | `rejected`, reason `data-url` |
| App URL, same doc | untouched | — |
| App URL, other doc | existing `reconcileCrossDocImages` (copy if readable, else strip) | `copied` / `rejected` |

Invariant (SC-003): after the pass, the stored document contains **zero** `http(s)`-external and **zero** `data:` image srcs.

## Test contract (SC-004, Principle II)

- Unit-test the address validator across families: every blocked range above (v4, v6, v4-mapped-v6, metadata IP), plus globals that must pass.
- Redirect-based probe: public host 302 → `http://169.254.169.254/…` must be blocked at hop validation with **zero connection attempts** to the blocked address (assert via injected connect/lookup fakes — tests never do real network I/O).
- DNS-rebind shape: resolver returning a public IP at validation must be immune by construction (pinned connect) — assert the connected address equals the validated one.
- Streaming-cap test: a body exceeding 15 MB aborts mid-stream.
- Budget/dedup test: 5 references to one URL ⇒ 1 fetch, 1 `document_images` row, 5 nodes sharing one src; 21+ unique URLs ⇒ 20 fetches + `budget-exhausted` degradations.
- Time-budget test: with injected delayed fetchers, an expired aggregate budget aborts the in-flight fetch and degrades all remaining images with reason `time-budget-exhausted` (distinct from fetch failures).
- Concurrency test: with injected fetchers, the pass runs fetches in parallel up to the bound (4) and never exceeds it; and the SSRF guarantees hold under concurrency (a blocked target is never connected while other fetches are in flight).
