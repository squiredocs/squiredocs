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
 * The repository URL is GITHUB_REPO_URL from the checker (D4): repointing it is
 * a one-line change here and in the pages.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GITHUB_REPO_URL,
  COPY_RULES,
  stripStampedFooter,
  stripHtmlComments,
  findCopyRuleViolations,
} from '../../scripts/check-copy-rules.mjs';
import { FOOTER, syncFooterIntoHtml } from '../../scripts/site-footer.mjs';

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
    ['"LGPL"', '<p>Licensed under the LGPL.</p>', 'other-license'],
    ['"GPLv3"', '<p>Released as GPLv3.</p>', 'other-license'],
    ['"SquireDocs" run together', '<p>Try SquireDocs today.</p>', 'bare-squire'],
    ['"Unlimited Docs"', '<h2>Unlimited Docs</h2>', 'retired-string'],
    ['the "Dedicated Instance" plan name', '<h2>Dedicated Instance</h2>', 'retired-string'],
    ['"ChatGPT"', '<p>Use ChatGPT inside your doc.</p>', 'retired-string'],
    ['"spec-driven" in an <h2>', '<h2>For spec-driven teams</h2>', 'spec-driven-heading'],
    ['"spec-driven" in the meta description', '<meta name="description" content="Docs for spec-driven teams." />', 'spec-driven-heading'],
  ];

  for (const [label, text, rule] of mustFire) {
    it(`flags ${label} as ${rule}`, () => {
      const fired = rulesFired(text);
      expect(fired, `expected ${rule}; got:\n${describeViolations(findCopyRuleViolations(text))}`).toContain(rule);
    });
  }

  it('flags an unlinked body "MIT" as mit-unlinked', () => {
    const text = `<p>It is MIT licensed.</p><a href="${GITHUB_REPO_URL}">MIT</a>`;
    expect(rulesFired(text, { requireMit: true })).toContain('mit-unlinked');
  });

  it('flags a page with no "MIT" as mit-missing', () => {
    expect(rulesFired('<p>Squire Docs is open source.</p>', { requireMit: true })).toContain('mit-missing');
  });

  const mustPass = [
    ['"every"', '<p>Every edit is attributed, every time.</p>'],
    ['"Squire Docs"', '<p>Squire Docs is open source.</p>'],
    ['squiredocs.com', '<a href="https://squiredocs.com/install.sh">squiredocs.com</a>'],
    ['github.com/squiredocs', `<a href="${GITHUB_REPO_URL}">github.com/squiredocs</a>`],
    ['"z.ai (GLM)"', '<p>Anthropic, OpenAI, z.ai (GLM), or OpenRouter.</p>'],
    ['an &mdash; inside an HTML comment', '<!-- a marker &mdash; and — here --><p>Clean.</p>'],
    ['"a dedicated instance" in lowercase prose (RBD-062-20)', '<p>We run a dedicated instance for you.</p>'],
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
    const text = `<p>Open source under the <a href="${GITHUB_REPO_URL}">MIT license</a>.</p>`;
    const vs = findCopyRuleViolations(text, { requireMit: true });
    expect(vs, describeViolations(vs)).toHaveLength(0);
  });

  it('exempts "MIT" in <head> meta text when the body MIT is linked', () => {
    const text = `<html><head><meta name="description" content="Open source, MIT licensed." /></head>
      <body><p><a href="${GITHUB_REPO_URL}">MIT licensed</a></p></body></html>`;
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

const text = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

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
  for (const name of ['landing.html', 'pricing.html', 'about.html']) {
    it(`${name} has no copy-rule violations`, () => {
      const vs = findCopyRuleViolations(stripStampedFooter(readPage(name)), { requireMit: true });
      expect(vs, vs.map((v) => `${name}: ${v.rule} "${v.match}"`).join('\n')).toHaveLength(0);
    });
  }

  it('the FOOTER source in site-footer.mjs has no copy-rule violations', () => {
    const vs = findCopyRuleViolations(FOOTER, { requireMit: false });
    expect(vs, vs.map((v) => `site-footer.mjs FOOTER: ${v.rule} "${v.match}"`).join('\n')).toHaveLength(0);
  });
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
    const strip = block(html, '<div class="landing-trust-strip">', '<section');
    const items = strip.match(/<div class="landing-trust-item">/g) || [];
    expect(items).toHaveLength(3);
    expectInOrder(
      text(strip),
      ['Open source (MIT)', 'Every edit attributed and reversible', 'Your docs sync to markdown'],
      'trust strip',
    );
    expect(strip).toMatch(new RegExp(`<a href="${GITHUB_REPO_URL}"[^>]*>Open source \\(MIT\\)</a>`));
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
      'With Docker installed, tell your agent "set up Squire Docs locally." It runs the install script, prints a sign-in link, and connects itself. Two clicks and you have your own instance on localhost, with no accounts or API keys to configure.',
    );
    expect(html).toContain('<code>curl -fsSL https://squiredocs.com/install.sh | sh</code>');
    expect(html).toMatch(new RegExp(`<a href="${SELF_HOST_URL}"[^>]*>Read the self-host guide</a>`));
    expect(html).toMatch(new RegExp(`<a href="${GITHUB_REPO_URL}"[^>]*>View on GitHub</a>`));
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

describe('pricing launch copy (US2, FR-014 to FR-020, FR-028)', () => {
  const html = readPage('pricing.html');
  const DESCRIPTION =
    'Squire Docs is free during public beta on squiredocs.com, with $10 of AI credits a month or your own API key. Self-host it free as open source software, or ask us for a managed instance in the cloud region you choose.';
  const OG_DESCRIPTION =
    'Free during beta, free to self-host, or a managed instance in the cloud region you choose.';

  it('title and meta text (FR-020, RBD-062-15)', () => {
    expect(titleOf(html)).toBe('Pricing | Squire Docs');
    expect(metaContent(html, 'property', 'og:title')).toBe('Pricing | Squire Docs');
    expect(metaContent(html, 'name', 'description')).toBe(DESCRIPTION);
    expect(metaContent(html, 'property', 'og:description')).toBe(OG_DESCRIPTION);
    expect(html.match(/<head>[\s\S]*<\/head>/)[0]).not.toMatch(/Dedicated/);
  });

  it('hero describes all three options (FR-018, RBD-062-14)', () => {
    const hero = block(html, '<section class="pricing-hero">');
    expect(text(block(hero, '<h1', '</h1>'))).toBe('Use ours free, or run your own.');
    expect(text(block(hero, '<p', '</p>'))).toBe(
      'Squire Docs is free during public beta on squiredocs.com, and free to self-host as open source software. Managed instances are priced on request. No credit card needed.',
    );
  });

  it('exactly three plan cards in order with the design prices and actions (FR-014 to FR-016)', () => {
    const cards = html.split(/<div class="pricing-card(?: featured)?">/).slice(1).map((c) => c.slice(0, c.indexOf('</a>') + 4));
    expect(cards).toHaveLength(3);
    const expected = [
      ['Hosted', 'Free during beta', '<a href="/signup" class="landing-btn google">Start free</a>', /\$10 of AI credits a month/],
      ['Self-hosted', 'Free, open source', `<a href="${SELF_HOST_URL}" class="landing-btn outline">Run it yourself</a>`, /stays on your infrastructure/],
      ['Managed instance', 'Custom pricing', '<a href="mailto:contact@squiredocs.com?subject=Managed%20instance" class="landing-btn outline">', /cloud region you choose/],
    ];
    expected.forEach(([name, price, action, body], i) => {
      expect(cards[i]).toContain(`<h2>${name}</h2>`);
      expect(cards[i]).toContain(`<p class="pricing-price">${price}</p>`);
      expect(cards[i]).toContain(action);
      expect(text(cards[i])).toMatch(body);
    });
    expect(html).toMatch(/<div class="pricing-card featured">\s*<span class="pricing-badge">Public beta<\/span>\s*<h2>Hosted<\/h2>/);
  });

  it('comparison table columns and the sign-in, credits, and residency rows (FR-017, RBD-062-8)', () => {
    const table = block(html, '<div class="pricing-compare">', '</table>');
    expectInOrder(table, ['<th>Hosted</th>', '<th>Self-hosted</th>', '<th>Managed instance</th>'], 'table header');
    const row = (label) => {
      const r = table.split('<tr>').find((tr) => tr.includes(label));
      expect(r, `row "${label}" missing`).toBeTruthy();
      return (r.match(/<td>([\s\S]*?)<\/td>/g) || []).slice(1).map((td) => (td.includes('pricing-check') ? 'yes' : td.includes('pricing-dash') ? 'no' : text(td)));
    };
    expect(row('<td>Sign-in</td>')).toEqual(['Sign in with Google', 'Sign-in link minted by your instance', 'SSO']);
    expect(row('$10 of AI credits every month')).toEqual(['yes', 'no', 'no']);
    expect(row('Anthropic, Google (Gemini), OpenAI, z.ai (GLM), or OpenRouter')).toEqual(['yes', 'yes', 'yes']);
    expect(row('Runs on your own infrastructure')).toEqual(['no', 'yes', 'no']);
    expect(row('Hosted in the cloud region you choose')).toEqual(['no', 'no', 'yes']);
    expect(table.match(/<tr>/g)).toHaveLength(14); // header + 13 rows
  });

  it('FAQ carries the launch questions and answers (FR-019)', () => {
    const faq = block(html, '<div class="pricing-faq">', '</section>');
    const answer = (q) => {
      const d = faq.split('<details>').find((x) => x.includes(`<summary>${q}</summary>`));
      expect(d, `FAQ "${q}" missing`).toBeTruthy();
      return d.slice(d.indexOf('<p>'), d.indexOf('</p>') + 4);
    };
    for (const q of [
      'What happens when my credits run out?',
      'Do I need a credit card?',
      'What happens to my documents if I stop using Squire Docs?',
    ]) answer(q);
    const run = answer('Can we run Squire Docs ourselves?');
    expect(text(run)).toBe(
      'Yes. Squire Docs is open source under the MIT license. Install it with one command, or follow the self-host guide. If you want us to run a dedicated instance for you in the cloud region of your choice, email contact@squiredocs.com.',
    );
    expect(run).toContain(`<a href="${GITHUB_REPO_URL}">MIT license</a>`);
    expect(run).toContain(`<a href="${SELF_HOST_URL}">self-host guide</a>`);
    expect(text(answer('Is the hosted version the same software?'))).toBe(
      'Yes. squiredocs.com runs the same code as the public repository.',
    );
    expect(text(answer('Where can a managed instance run?'))).toBe(
      'In the cloud region you choose, including EU regions. Your documents, database, and backups stay in that region, which helps you meet data residency and sovereignty requirements. Email contact@squiredocs.com to discuss your region.',
    );
    expect(text(answer('Do I need an API key to self-host?'))).toBe(
      'No. The editor, version history, repo sync, and agent connection work without one, because your own agent brings the AI. Add your own key in Settings to turn on the built-in assistant. Semantic search turns on when the server has a Google AI key.',
    );
    const stay = answer('Will Squire Docs stay free?');
    expect(stay).toContain('and your documents export as markdown at any time.');
    expect(stay).toContain(`The open source project is <a href="${GITHUB_REPO_URL}">MIT licensed</a>.`);
  });

  it('old plan names are gone (FR-014)', () => {
    expect(html).not.toContain('Unlimited Docs');
    expect(html).not.toContain('Dedicated Instance');
    expect(html).not.toMatch(/<h2>Bring your own key<\/h2>|<th>Bring your own key<\/th>/);
  });

  it('closing band (FR-028)', () => {
    expectClosingBand(html, 'pricing.html');
  });
});

describe('about launch copy (US3, FR-021 to FR-025, FR-028)', () => {
  const html = readPage('about.html');

  it('title and meta text (FR-021, RBD-062-15)', () => {
    expect(titleOf(html)).toBe('About | Squire Docs');
    expect(metaContent(html, 'property', 'og:title')).toBe('About | Squire Docs');
    expect(metaContent(html, 'name', 'description')).toBe(
      'Coding agents write plans, specs, and reports. Squire Docs gives that work a shared, attributed document your team edits with the agent. Open source, MIT licensed, built by 21st Harmonic.',
    );
    expect(metaContent(html, 'property', 'og:description')).toBe(
      'Why Squire Docs exists: a shared document for the work your agents do, with every change attributed. Open source under the MIT license.',
    );
    const head = html.match(/<head>[\s\S]*<\/head>/)[0];
    for (const s of ['copy-paste', 'chat tab', 'engineering leaders']) expect(head).not.toContain(s);
  });

  it('hero H1 and subline (FR-021)', () => {
    const hero = block(html, '<section class="about-hero">');
    expect(text(block(hero, '<h1', '</h1>').replace(/<br\s*\/?>/g, ' '))).toBe(
      'Agents do real work now. They need somewhere to put it.',
    );
    expect(text(block(hero, '<p', '</p>'))).toBe(
      'Squire Docs gives the work your agents do a shared document your team can read, edit, and correct.',
    );
  });

  it('prose opens with the agent problem and has a "Why open source" paragraph (FR-022, FR-023)', () => {
    const prose = block(html, '<div class="about-prose">', '</section>');
    expect(prose).toContain(
      "<p>Coding agents write plans, specs, and reports, and most of it ends up in a terminal scrollback or a scratch file nobody else can see. Squire Docs gives that work a shared document: you and your team read it, edit it, and correct it while the agent is still working, and every change keeps its author.</p>",
    );
    expect(html).not.toContain('You know the ritual');
    expect(html).not.toContain('engineering leaders');
    const why = prose.split('<p>').find((p) => p.includes('Why open source'));
    expect(why, 'no "Why open source" paragraph').toBeTruthy();
    expect(why).toContain('inspect, run, and keep');
    expect(why).toMatch(new RegExp(`<a href="${GITHUB_REPO_URL}">MIT licensed</a>`));
    expect(why).toContain('same code');
    expect(why).toContain('21st Harmonic');
  });

  it('four "What we believe" cards with the launch wording (FR-024, RBD-062-6, RBD-062-19)', () => {
    const grid = block(html, '<div class="about-principles-grid">', '</section>');
    const cards = grid.split('<div class="landing-usecase-card">').slice(1);
    expect(cards).toHaveLength(4);
    const card = (h) => {
      const c = cards.find((x) => x.includes(`<h3>${h}</h3>`));
      expect(c, `card "${h}" missing`).toBeTruthy();
      return text(c.slice(c.indexOf('<p>'), c.indexOf('</p>') + 4));
    };
    card('The document is the interface');
    expect(card('Agent work is accountable work')).toBe(
      'Each edit is attributed to whoever made it, human or agent, and can be undone through version history.',
    );
    const open = card('Open to any model or agent');
    expect(open).toContain('z.ai (GLM)');
    expect(open).toContain('Anthropic, Google (Gemini), OpenAI, z.ai (GLM), or OpenRouter');
    expect(open.startsWith('A built-in agent')).toBe(false);
    expect(open).toMatch(/^Connect/);
    expect(card('Trust by design')).toBe('Your docs, your infrastructure: open source, markdown export, and self-hosting.');
    expect(grid).not.toMatch(/Google sign-in/);
  });

  it('keeps the "Who\'s behind it" section and contact card (FR-025)', () => {
    expect(html).toContain("<h2 class=\"landing-section-title\">Who's behind it</h2>");
    expect(html).toContain('<div class="about-contact-card">');
    expect(html).toContain('<a href="mailto:contact@squiredocs.com" class="landing-btn primary">contact@squiredocs.com</a>');
  });

  it('closing band (FR-028)', () => {
    expectClosingBand(html, 'about.html');
  });
});

// --- Block 3: shared footer, header nav, closing band (US4) -------------------

const STATIC_PAGES = ['landing.html', 'pricing.html', 'about.html', 'security.html'];

describe('footer is the single source (FR-026, FR-027, SC-003)', () => {
  for (const name of STATIC_PAGES) {
    it(`${name} carries the stamped FOOTER unchanged`, () => {
      const html = readPage(name);
      expect(syncFooterIntoHtml(html) === html, `${name} is out of sync: run npm run sync:footer in client/`).toBe(true);
    });
  }

  it('FOOTER has the launch tagline, GitHub, then Self-host', () => {
    const tagline = '<p class="landing-footer-tagline">Collaborative docs for people and AI agents</p>';
    expect(FOOTER.split(tagline)).toHaveLength(2);
    expectInOrder(
      FOOTER,
      [
        `<li><a href="${GITHUB_REPO_URL}">GitHub</a></li>`,
        `<li><a href="${SELF_HOST_URL}">Self-host</a></li>`,
      ],
      'footer Product column',
    );
    expect(FOOTER).toContain('<li><a href="/documentation">Documentation</a></li>');
  });

  it('no retired string remains in client/public/*.html or site-footer.mjs', () => {
    const retired = [
      'Write with AI, right in your doc',
      'Free. No Setup. Sign in with Google.',
      'Unlimited Docs',
      'Dedicated Instance',
    ];
    const files = fs
      .readdirSync(PUBLIC_DIR)
      .filter((f) => f.endsWith('.html'))
      .map((f) => path.join(PUBLIC_DIR, f));
    files.push(path.join(CLIENT_DIR, 'scripts', 'site-footer.mjs'));
    const hits = [];
    for (const file of files) {
      const body = fs.readFileSync(file, 'utf8');
      for (const s of retired) if (body.includes(s)) hits.push(`${path.relative(CLIENT_DIR, file)}: "${s}"`);
    }
    expect(hits, hits.join('\n')).toHaveLength(0);
  });
});

describe('header nav (FR-029, RBD-062-2)', () => {
  for (const name of STATIC_PAGES) {
    it(`${name} has GitHub and Self-host after Blog and before Sign In`, () => {
      const nav = block(readPage(name), '<nav class="landing-nav">', '</nav>');
      expectInOrder(
        nav,
        [
          'href="/blog" class="landing-nav-link',
          `<a href="${GITHUB_REPO_URL}" class="landing-nav-link`,
          `<a href="${SELF_HOST_URL}" class="landing-nav-link`,
          'href="/login"',
        ],
        `${name} nav`,
      );
      expect(nav).toContain('<a href="/documentation" class="landing-nav-link">Documentation</a>');
      expect(nav).not.toMatch(/star/i);
    });
  }
});

describe('closing band is identical on landing, pricing, and about (FR-028)', () => {
  it('the three cta sections match', () => {
    const bands = ['landing.html', 'pricing.html', 'about.html'].map((n) => {
      const cta = block(readPage(n), '<section class="landing-section cta">');
      return cta.slice(cta.indexOf('<h2'));
    });
    expect(bands[1]).toBe(bands[0]);
    expect(bands[2]).toBe(bands[0]);
  });
});

// --- Block 5: injected regressions are caught (US5 scenario 2, SC-004) -------

describe('injected regressions are caught on the real pages (US5)', () => {
  const fixtures = [
    ['bare "Squire"', 'Design in Squire, then sync.', 'bare-squire'],
    ['an em dash', `Docs ${EM_DASH} for agents.`, 'em-dash'],
    ['"honestly"', 'Honestly, it works.', 'honest'],
    ['"free forever"', 'It is free forever.', 'forever'],
    ['"pull request"', 'Agent edits arrive as a pull request.', 'pr-framing'],
    ['"GLM" without "z.ai ("', 'Use GLM or Claude.', 'glm-label'],
    ['"AGPL"', 'Licensed under the AGPL.', 'other-license'],
  ];
  const inject = (html, sentence) => {
    const anchor = html.includes('</main>') ? '</main>' : '<section class="landing-section cta">';
    expect(html, 'no injection point').toContain(anchor);
    return html.replace(anchor, `<p>${sentence}</p>\n${anchor}`);
  };

  for (const name of ['landing.html', 'pricing.html', 'about.html']) {
    const page = stripStampedFooter(readPage(name));

    it(`${name} is clean before injection`, () => {
      expect(findCopyRuleViolations(page, { requireMit: true })).toHaveLength(0);
    });

    for (const [label, sentence, rule] of fixtures) {
      it(`${name}: injecting ${label} fires ${rule}`, () => {
        const vs = findCopyRuleViolations(inject(page, sentence), { requireMit: true });
        expect(vs.map((v) => v.rule), describeViolations(vs)).toContain(rule);
      });
    }
  }

  it('removing the GitHub link wrappers on pricing fires mit-unlinked (RBD-062-16)', () => {
    const page = stripStampedFooter(readPage('pricing.html'));
    const unwrapped = page.replace(
      new RegExp(`<a href="${GITHUB_REPO_URL}"[^>]*>([\\s\\S]*?)</a>`, 'g'),
      '$1',
    );
    expect(rulesFired(unwrapped, { requireMit: true })).toContain('mit-unlinked');
  });
});
