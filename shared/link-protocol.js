/**
 * Link-href protocol allowlist — the single source of truth for which link
 * `href` schemes an agent-authored or imported document may store.
 *
 * Pure (no Yjs, no Node built-ins), so it bundles cleanly into the sandbox
 * isolate and is consumed identically by every write boundary (FR-022, CN-9):
 *   - the markdown import pipeline (server/mcp/yjs/pm-json-transforms.js →
 *     sanitizeLinkMarks, run in all three PM-JSON materialization paths:
 *     REST/create import, the two-way-sync engine, and the sandbox
 *     `fromMarkdown` helper), and
 *   - the modify post-script pass over the live Yjs fragment
 *     (server/mcp/image-validate.js → sanitizeLinkHrefs).
 *
 * Extracted from pm-json-transforms.js (D-6, Sam 2026-07-13) so import and the
 * modify write boundary share ONE validator rather than duplicating the
 * scheme-parse rules. The rule: allow http/https/mailto and scheme-less
 * app-relative (`/…`) or fragment (`#…`) hrefs; everything else
 * (javascript:/data:/vbscript:/file:/…) is non-conforming — callers drop the
 * link mark and keep the text.
 */

/**
 * Strip C0 controls / whitespace, then read a URL scheme (lowercased).
 * Browsers ignore control and whitespace characters when parsing a scheme, so
 * we strip them everywhere before matching — otherwise `jav\tascript:` or
 * `java\nscript:` would sneak a dangerous scheme past a naive prefix check.
 * @param {string} href
 * @returns {string|null} lowercased scheme, or null if scheme-less
 */
function schemeOf(href) {
  if (typeof href !== 'string') return null;
  const cleaned = href.replace(/[\u0000-\u0020\u007f\s]+/g, '');
  const m = cleaned.match(/^([a-z][a-z0-9+.-]*):/i);
  return m ? m[1].toLowerCase() : null;
}

/** Cleaned href (control/whitespace-stripped) for prefix checks. */
function cleanedHref(href) {
  return typeof href === 'string' ? href.replace(/[\u0000-\u0020\u007f\s]+/g, '') : '';
}

const ALLOWED_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);

/** Whether a link href passes the protocol allowlist (FR-022, CN-9). */
function isAllowedLinkHref(href) {
  const scheme = schemeOf(href);
  if (scheme) return ALLOWED_LINK_SCHEMES.has(scheme);
  // Scheme-less: app-relative paths and fragments are allowed. `//host` is
  // scheme-relative http(s), which the allowlist permits anyway.
  const cleaned = cleanedHref(href);
  return cleaned.startsWith('/') || cleaned.startsWith('#');
}

module.exports = {
  schemeOf,
  cleanedHref,
  isAllowedLinkHref,
  ALLOWED_LINK_SCHEMES,
};
