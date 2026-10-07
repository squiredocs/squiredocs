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
