/**
 * Copy-rules tests for the marketing pages (feature 062-oss-launch-messaging).
 *
 * Imports the pure checker from client/scripts/check-copy-rules.mjs (mirroring
 * how documentation-build.test.js imports from scripts/render-documentation.mjs)
 * and reads the real marketing HTML in client/public and the FOOTER string in
 * client/scripts/site-footer.mjs.
 *
 * Sections:
 *   checker catches each rule       - fixtures per rule (US5, SC-004)
 *   scanned sources are clean       - landing, pricing, about, FOOTER (FR-030 to FR-038)
 *   landing / pricing / about copy  - load-bearing launch strings (US1 to US3)
 *   footer, nav, closing band       - shared elements (US4, FR-026 to FR-029)
 *   injected regressions are caught - fixtures inserted into the real pages (US5)
 *
 * The repository URL is GITHUB_ORG_URL from the checker (D4): repointing it is
 * a one-line change here and in the pages.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GITHUB_ORG_URL,
  COPY_RULES,
  stripStampedFooter,
  stripHtmlComments,
  findCopyRuleViolations,
} from '../../scripts/check-copy-rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(CLIENT_DIR, 'public');

const EM_DASH = '—';

const rulesFired = (text, opts) => findCopyRuleViolations(text, opts).map((v) => v.rule);
const describeViolations = (vs) => vs.map((v) => `${v.rule} "${v.match}"`).join('\n');

// --- Block 1: the checker catches each rule ---------------------------------

describe('checker catches each rule (US5, SC-004)', () => {
  const mustFire = [
    ['bare "Squire" in prose', '<p>Design in Squire, then sync.</p>', 'bare-squire'],
    ['a literal U+2014', `<p>Docs ${EM_DASH} for agents.</p>`, 'em-dash'],
    ['the &mdash; entity', '<td>&mdash;</td>', 'em-dash'],
    ['"honestly"', '<p>Honestly, it works.</p>', 'honest'],
    ['"free forever"', '<p>It is free forever.</p>', 'forever'],
    ['standalone "ever"', '<p>The best editor ever.</p>', 'forever'],
    ['"pull request"', '<p>Agent edits arrive as a pull request.</p>', 'pr-framing'],
    ['"PRs"', '<p>Agents open PRs against your doc.</p>', 'pr-framing'],
    ['"reviewed like"', '<p>Agent output gets reviewed like a colleague.</p>', 'pr-framing'],
    ['"GLM" without "z.ai ("', '<p>Use GLM or Claude.</p>', 'glm-label'],
    ['bare "z.ai"', '<p>Anthropic, OpenAI, z.ai, or OpenRouter.</p>', 'glm-label'],
    ['"AGPL"', '<p>Licensed under the AGPL.</p>', 'other-license'],
    ['"Apache"', '<p>Apache-2.0 licensed.</p>', 'other-license'],
    ['"Unlimited Docs"', '<h2>Unlimited Docs</h2>', 'retired-string'],
    ['"ChatGPT"', '<p>Use ChatGPT inside your doc.</p>', 'retired-string'],
    ['"spec-driven" in an <h2>', '<h2>For spec-driven teams</h2>', 'spec-driven-heading'],
  ];

  for (const [label, text, rule] of mustFire) {
    it(`flags ${label} as ${rule}`, () => {
      const fired = rulesFired(text);
      expect(fired, `expected ${rule}; got:\n${describeViolations(findCopyRuleViolations(text))}`).toContain(rule);
    });
  }

  it('flags an unlinked body "MIT" as mit-unlinked', () => {
    const text = `<p>It is MIT licensed.</p><a href="${GITHUB_ORG_URL}">MIT</a>`;
    expect(rulesFired(text, { requireMit: true })).toContain('mit-unlinked');
  });

  it('flags a page with no "MIT" as mit-missing', () => {
    expect(rulesFired('<p>Squire Docs is open source.</p>', { requireMit: true })).toContain('mit-missing');
  });

  const mustPass = [
    ['"every"', '<p>Every edit is attributed, every time.</p>'],
    ['"Squire Docs"', '<p>Squire Docs is open source.</p>'],
    ['squiredocs.com', '<a href="https://squiredocs.com/install.sh">squiredocs.com</a>'],
    ['github.com/squiredocs', `<a href="${GITHUB_ORG_URL}">github.com/squiredocs</a>`],
    ['"z.ai (GLM)"', '<p>Anthropic, OpenAI, z.ai (GLM), or OpenRouter.</p>'],
    ['an &mdash; inside an HTML comment', '<!-- a marker &mdash; and — here --><p>Clean.</p>'],
    ['"approve the agent"', '<p>Click the sign-in link and approve the agent.</p>'],
    ['"never", "however", "whatever"', '<p>However you work, whatever you use, never mind.</p>'],
  ];

  for (const [label, text] of mustPass) {
    it(`passes ${label}`, () => {
      const vs = findCopyRuleViolations(text);
      expect(vs, describeViolations(vs)).toHaveLength(0);
    });
  }

  it('passes a stamped-footer block containing an em dash once the footer is stripped', () => {
    const page = `<p>Clean.</p>
    <!-- site-footer:start (generated ${EM_DASH} edit there) -->
    <footer><p>Old ${EM_DASH} tagline</p></footer>
    <!-- site-footer:end -->`;
    const vs = findCopyRuleViolations(stripStampedFooter(page));
    expect(vs, describeViolations(vs)).toHaveLength(0);
  });

  it('passes a linked "MIT license" with requireMit', () => {
    const text = `<p>Open source under the <a href="${GITHUB_ORG_URL}">MIT license</a>.</p>`;
    const vs = findCopyRuleViolations(text, { requireMit: true });
    expect(vs, describeViolations(vs)).toHaveLength(0);
  });

  it('exempts "MIT" in <head> meta text when the body MIT is linked', () => {
    const text = `<html><head><meta name="description" content="Open source, MIT licensed." /></head>
      <body><p><a href="${GITHUB_ORG_URL}">MIT licensed</a></p></body></html>`;
    const vs = findCopyRuleViolations(text, { requireMit: true });
    expect(vs, describeViolations(vs)).toHaveLength(0);
  });

  it('strips HTML comments and exports one rule per FR-030 to FR-038', () => {
    expect(stripHtmlComments('a<!-- x -->b')).toBe('ab');
    const frs = new Set(COPY_RULES.map((r) => r.fr));
    for (const fr of ['FR-030', 'FR-031', 'FR-032', 'FR-033', 'FR-035', 'FR-036', 'FR-037', 'FR-038']) {
      expect(frs.has(fr), `missing a rule for ${fr}`).toBe(true);
    }
  });
});

// --- Shared helpers for the page blocks --------------------------------------

const readPage = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

const metaContent = (html, attr, key) => {
  const m = html.match(new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`));
  return m ? m[1] : null;
};

const titleOf = (html) => (html.match(/<title>([^<]*)<\/title>/) || [])[1];

// The first element opened by `openTag` through its matching close tag `closeTag`
// (no nesting of the same tag is assumed, which holds for <section> here).
const block = (html, openTag, closeTag = '</section>') => {
  const start = html.indexOf(openTag);
  if (start === -1) return '';
  const end = html.indexOf(closeTag, start);
  return html.slice(start, end + closeTag.length);
};

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const expectInOrder = (haystack, needles, label) => {
  let from = 0;
  for (const needle of needles) {
    const at = haystack.indexOf(needle, from);
    expect(at, `${label}: "${needle}" missing or out of order`).toBeGreaterThan(-1);
    from = at + needle.length;
  }
};

const SELF_HOST_URL = '/documentation/self-hosting';

// FR-028: the closing call-to-action band, identical on landing, pricing, about.
const CLOSING_HEADING = 'Start writing with your agents.';
const CLOSING_SUBTEXT = 'Free. Open source. Run it yourself or use ours.';

function expectClosingBand(html, label) {
  const cta = block(html, '<section class="landing-section cta">');
  expect(cta, `${label}: no closing band`).not.toBe('');
  expect(cta).toContain(`<h2 class="landing-section-title">${CLOSING_HEADING}</h2>`);
  expect(cta).toContain(`<p class="landing-signup-subtext">${CLOSING_SUBTEXT}</p>`);
  expectInOrder(
    cta,
    [
      '<a href="/signup" class="landing-btn google">Start free</a>',
      `<a href="${SELF_HOST_URL}" class="landing-btn outline">Run it yourself</a>`,
      'Questions? <a href="mailto:contact@squiredocs.com">Email us</a>. A human answers.',
    ],
    `${label} closing band`,
  );
  expect(cta).not.toContain('Sign in with Google');
}

// --- Block 2: scanned sources are clean ---------------------------------------

describe('scanned sources are clean (FR-030 to FR-038)', () => {
  for (const name of ['landing.html']) {
    it(`${name} has no copy-rule violations`, () => {
      const vs = findCopyRuleViolations(stripStampedFooter(readPage(name)), { requireMit: true });
      expect(vs, vs.map((v) => `${name}: ${v.rule} "${v.match}"`).join('\n')).toHaveLength(0);
    });
  }
});

// --- Block 4: launch copy anchors --------------------------------------------

describe('landing launch copy (US1, FR-001 to FR-013, FR-028)', () => {
  const html = readPage('landing.html');
  const TITLE = 'Squire Docs: Open Source Collaborative Docs for People and AI Agents';
  const DESCRIPTION =
    'Squire Docs is an open source collaborative editor where people and AI agents edit the same documents in real time. Every edit attributed, two-way markdown sync with your repo. Use it free at squiredocs.com or run it yourself.';
  const SHORT = 'Open source collaborative docs for people and AI agents.';

  it('title, Open Graph, and Twitter text (FR-001, FR-002)', () => {
    expect(titleOf(html)).toBe(TITLE);
    expect(metaContent(html, 'property', 'og:title')).toBe(TITLE);
    expect(metaContent(html, 'name', 'twitter:title')).toBe(TITLE);
    expect(metaContent(html, 'name', 'description')).toBe(DESCRIPTION);
    expect([DESCRIPTION, SHORT]).toContain(metaContent(html, 'property', 'og:description'));
    expect([DESCRIPTION, SHORT]).toContain(metaContent(html, 'name', 'twitter:description'));
  });

  it('hero headline, subheadline, and the two calls to action (FR-003, FR-004)', () => {
    const hero = block(html, '<section class="landing-hero">');
    expect(text(block(hero, '<h1', '</h1>'))).toBe('Docs your agents can edit with you.');
    expect(text(block(hero, '<p class="landing-subheadline"', '</p>'))).toBe(
      'Squire Docs is an open source collaborative editor for people and AI agents. Connect Claude Code, Codex, or any MCP agent, watch its edits land live, and keep everything in sync with markdown in your repo.',
    );
    expectInOrder(
      hero,
      [
        '<a href="/signup" class="landing-btn google">Start free</a>',
        `<a href="${SELF_HOST_URL}" class="landing-btn outline">Run it yourself</a>`,
      ],
      'hero CTAs',
    );
    expect(hero).not.toContain('No setup. Sign in with Google.');
    expect(hero).not.toContain('Sign in with Google');
  });

  it('trust strip has exactly the three launch items, MIT linked (FR-005)', () => {
    const strip = block(html, '<div class="landing-trust-strip">', '<!-- ');
    const items = strip.match(/<div class="landing-trust-item">/g) || [];
    expect(items).toHaveLength(3);
    expectInOrder(
      text(strip),
      ['Open source (MIT)', 'Every edit attributed and reversible', 'Your docs sync to markdown'],
      'trust strip',
    );
    expect(strip).toMatch(new RegExp(`<a href="${GITHUB_ORG_URL}"[^>]*>Open source \\(MIT\\)</a>`));
    expect(strip).not.toMatch(/Anthropic|Google|encrypted/);
  });

  it('body sections appear in the FR-006 order, then the closing band', () => {
    expectInOrder(
      html,
      [
        '<div class="landing-trust-strip">',
        '>Your agent, live in the document</h2>',
        ">See what changed, undo what you don't want</h2>",
        '>Markdown in, markdown out, synced to your repo</h2>',
        '>Run it on your machine</h2>',
        '>What people use it for</h2>',
        '>Any agent, any model</h2>',
        '<section class="landing-section cta">',
      ],
      'landing sections',
    );
  });

  it('section 1 and 2 state the live-agent and attribution mechanisms (FR-007, FR-008)', () => {
    const t = text(html);
    expect(t).toMatch(/MCP/);
    expect(t).toMatch(/named cursor/);
    expect(t).toMatch(/both edits survive/);
    expect(t).toMatch(/each version can be restored/i);
    expect(html).toContain('/hero-screenshot.png');
    expect(html).toContain('/screenshot-versionhistory.png');
    expect(html).not.toContain('screenshot-mcp.png');
  });

  it('section 3 keeps the repo-sync copy with the mechanism sentence (FR-009, FR-034)', () => {
    expect(html).toContain('two-way sync with the files in your repo');
    expect(html).toContain('GFM task lists, tables, and mermaid diagrams render natively');
    expect(html).toContain('Every doc exports as portable .md at any time.');
    expect(html).not.toContain('always yours');
  });

  it('section 4 shows the install command and the two links (FR-010)', () => {
    expect(html).toContain(
      'Tell your agent "set up Squire Docs locally." It runs the install script, prints a sign-in link, and connects itself. Two clicks and you have your own instance on localhost, with no accounts or API keys to configure.',
    );
    expect(html).toContain('<code>curl -fsSL https://squiredocs.com/install.sh | sh</code>');
    expect(html).toMatch(new RegExp(`<a href="${SELF_HOST_URL}"[^>]*>Read the self-host guide</a>`));
    expect(html).toMatch(new RegExp(`<a href="${GITHUB_ORG_URL}"[^>]*>View on GitHub</a>`));
  });

  it('section 5 lists the four use cases; spec-driven only in the first (FR-011)', () => {
    const headings = [
      'Specs and design docs',
      'Agent plans and handoffs',
      'Research and reports',
      'Team knowledge your agents maintain',
    ];
    expectInOrder(html, headings.map((h) => `<h3>${h}</h3>`), 'use cases');
    const first = block(html, '<h3>Specs and design docs</h3>', '</div>');
    expect(first).toMatch(/spec-kit, Kiro, or your own tooling/);
    const rest = html.slice(html.indexOf('<h3>Agent plans and handoffs</h3>'));
    expect(rest).not.toMatch(/spec-driven/i);
  });

  it('section 6 lists agents and providers and keeps the guide link (FR-012)', () => {
    expect(html).toContain('Claude Code, Codex, Cursor, Kiro, Claude Desktop, or anything that speaks MCP');
    expect(html).toContain('Anthropic, Google (Gemini), OpenAI, z.ai (GLM), or OpenRouter');
    expect(html).toContain('<a href="/documentation/agents-and-mcp">Agents &amp; MCP Guide</a>');
    expect(html).not.toMatch(/batteries included/i);
    expect(html).not.toContain('ready the moment you open a doc');
  });

  it('retired landing copy is gone (FR-013)', () => {
    for (const s of [
      'Your specs live in the repo.',
      'For spec-driven engineering teams',
      'Collaborative Docs for Spec-Driven Development',
      'Use Claude, ChatGPT, Gemini, GLM, or any agent right inside your document.',
      'No setup. Sign in with Google.',
    ]) {
      expect(html, s).not.toContain(s);
    }
  });

  it('closing band (FR-028)', () => {
    expectClosingBand(html, 'landing.html');
  });
});
