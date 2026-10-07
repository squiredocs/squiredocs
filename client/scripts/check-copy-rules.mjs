/**
 * check-copy-rules.mjs: the launch copy rules for the marketing pages
 * (feature 062-oss-launch-messaging, spec FR-030 to FR-038).
 *
 * Pure functions over a string; no file I/O and no dependencies, so the
 * Vitest suite (src/__tests__/marketing-copy-rules.test.js) can run every rule
 * against fixtures and against the real pages.
 *
 *   GITHUB_REPO_URL                               -> the repository link target (D4)
 *   COPY_RULES                                   -> [{ id, fr, patterns: RegExp[] }]
 *   stripStampedFooter(html)                     -> html without the site-footer block
 *   stripHtmlComments(text)                      -> text without <!-- ... --> comments
 *   findCopyRuleViolations(text, { requireMit }) -> [{ rule, match, index }]
 *
 * The scan covers landing.html, pricing.html, about.html (stamped footer
 * removed, since FOOTER is scanned once at its source in site-footer.mjs) and
 * the FOOTER string itself. HTML comments are stripped first, so build markers
 * such as the footer sync comment are not copy.
 *
 * Repository URL repoint (D4): when the repository name is decided, change
 * GITHUB_REPO_URL here and every GitHub link in the pages and site-footer.mjs in
 * the same change. The MIT link rule (RBD-062-16) reads this constant.
 */

export const GITHUB_REPO_URL = 'https://github.com/squiredocs/squiredocs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Literal retired strings (FR-038), matched case-insensitively.
const RETIRED_STRINGS = [
  'Write with AI, right in your doc',
  'Free. No Setup. Sign in with Google.',
  'Unlimited Docs',
  'Batteries included',
  'ChatGPT',
];
// Retired plan names matched case-sensitively: the FR-019 FAQ answer says "run
// a dedicated instance for you" in lowercase prose (RBD-062-20).
const RETIRED_NAMES = ['Dedicated Instance'];

export const COPY_RULES = [
  // FR-030: the product name is "Squire Docs". Case-sensitive, so the
  // lowercase hostnames squiredocs.com and github.com/squiredocs never match.
  { id: 'bare-squire', fr: 'FR-030', patterns: [/\bSquire\b(?! Docs)/g, /\bSquireDocs\b/g] },
  // FR-031: no em dash in any encoding.
  { id: 'em-dash', fr: 'FR-031', patterns: [/—|&mdash;|&#8212;|&#x2014;/gi] },
  // FR-032
  { id: 'honest', fr: 'FR-032', patterns: [/\bhonest(?:ly)?\b/gi] },
  // FR-033: no forever promises ("ever" is word-bounded, so "every" passes).
  {
    id: 'forever',
    fr: 'FR-033',
    patterns: [/\bforever\b|\balways free\b|\bnever charge\b|\bever\b/gi],
  },
  // FR-035: the provider is always "z.ai (GLM)".
  { id: 'glm-label', fr: 'FR-035', patterns: [/(?<!z\.ai \()\bGLM\b|\bz\.ai\b(?! \(GLM\))/g] },
  // FR-036: no PR-review or approval framing of agent edits. "approve" alone
  // is allowed (approving an agent's connection, RBD-062-6). The PR token is
  // case-sensitive so ordinary lowercase text cannot trip it.
  {
    id: 'pr-framing',
    fr: 'FR-036',
    patterns: [
      /\bpull requests?\b|\bcode review\b|\bfor approval\b|\bfor review\b|\breviewed like\b|\breview the agent\b/gi,
      /\bPRs?\b/g,
    ],
  },
  // FR-037: MIT is the only license named.
  { id: 'other-license', fr: 'FR-037', patterns: [/\b(?:A|L)?GPL(?:v?\d)?\b|\bApache\b|\bBSD\b|\bMPL\b/gi] },
  // FR-038: retired strings.
  {
    id: 'retired-string',
    fr: 'FR-038',
    patterns: [
      new RegExp(RETIRED_STRINGS.map(escapeRe).join('|'), 'gi'),
      new RegExp(RETIRED_NAMES.map(escapeRe).join('|'), 'g'),
    ],
  },
];

/** Remove the stamped footer block (<!-- site-footer:start ... site-footer:end -->). */
export function stripStampedFooter(html) {
  return String(html).replace(/<!-- site-footer:start[\s\S]*?<!-- site-footer:end -->/g, '');
}

/** Remove every HTML comment. */
export function stripHtmlComments(text) {
  return String(text).replace(/<!--[\s\S]*?-->/g, '');
}

// "spec-driven" in a title or heading (FR-038, FR-011).
const HEADING_CONTAINERS = [
  /<title\b[^>]*>([\s\S]*?)<\/title>/gi,
  /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi,
  /<meta\s+(?:property|name)="(?:og|twitter):title"\s+content="([^"]*)"/gi,
  /<meta\s+name="description"\s+content="([^"]*)"/gi,
];

function collect(re, text, rule, out, offset = 0) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ rule, match: m[0], index: m.index + offset });
    if (m[0] === '') re.lastIndex++;
  }
}

/**
 * Return every copy-rule violation in text as { rule, match, index }.
 * With requireMit, the text must name MIT at least once (D3, FR-037), and
 * every body "MIT" (outside <head>) must sit inside a link to GITHUB_REPO_URL
 * (RBD-062-16).
 */
export function findCopyRuleViolations(text, { requireMit = false } = {}) {
  const s = stripHtmlComments(text);
  const out = [];

  for (const rule of COPY_RULES) {
    for (const re of rule.patterns) collect(re, s, rule.id, out);
  }

  for (const container of HEADING_CONTAINERS) {
    container.lastIndex = 0;
    let m;
    while ((m = container.exec(s)) !== null) {
      if (/spec-driven/i.test(m[1])) {
        out.push({ rule: 'spec-driven-heading', match: m[0], index: m.index });
      }
    }
  }

  if (requireMit) {
    if (!/\bMIT\b/.test(s)) {
      out.push({ rule: 'mit-missing', match: '', index: -1 });
    }
    const body = s.replace(/<head\b[\s\S]*?<\/head>/i, '');
    const linkRe = new RegExp(`<a\\s+href="${escapeRe(GITHUB_REPO_URL)}"[^>]*>[\\s\\S]*?<\\/a>`, 'g');
    const unlinked = body.replace(linkRe, '');
    collect(/\bMIT\b/g, unlinked, 'mit-unlinked', out);
  }

  return out.sort((a, b) => a.index - b.index);
}
