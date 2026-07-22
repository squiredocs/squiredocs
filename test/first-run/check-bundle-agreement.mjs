#!/usr/bin/env node
/**
 * Feature 030 US2 (T009, FR-021, SC-004) — bundle drift guard.
 *
 * Re-derives what the bundle SHOULD be from `distribution/shared/` (via the same
 * assemble-bundle.mjs functions the writer uses) and compares it to the on-disk
 * assembled bundle. Exits non-zero on any divergence, so a hand-edited generated
 * file — or a `shared/` edit that was never re-assembled — cannot silently enter
 * rehearsals.
 *
 * The `.mcp.json` `url` field is the ONE exempt field: the harness templates the
 * endpoint to the dev server per run (029 endpoint indirection). Everything else,
 * including the do-not-hand-edit headers, must match byte-for-byte.
 *
 * (The full multi-channel drift-vs-shared CI test is M3 — this guards only the
 * single rehearsal bundle.)
 *
 * Usage:
 *   node test/first-run/check-bundle-agreement.mjs [--bundle <dir>]
 *
 * Programmatic:
 *   import { checkBundleAgreement } from './check-bundle-agreement.mjs'  // → { ok, problems }
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedFiles, DEFAULT_BUNDLE_DIR, PROD_ENDPOINT, SHARED_DIR } from './assemble-bundle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Content-length budgets (RBD-13; numbers from Claude Code skill-authoring best
// practices). The skill `description` is ALWAYS resident once installed and the
// /skills UI truncates at 250 chars; the SKILL.md body and the onboard command
// markdown tax context on every use. Enforced here so a budget overrun is a
// FAILING test, not a hope.
export const BUDGETS = {
  skillDescriptionChars: 250, // /skills UI truncation cap (issue #40121)
  skillBodyLines: 400,        // hard ceiling; target 150–250
  onboardLines: 300,          // command injected whole per invocation; target ≤250
};

function frontmatterDescription(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const d = m[1].match(/^description:\s*(.*)$/m);
  return d ? d[1].trim() : null;
}

function bodyAfterFrontmatter(src) {
  return src.replace(/^---\n[\s\S]*?\n---\n/, '');
}

/** Content-budget checks over distribution/shared/ (RBD-13). Returns problems[]. */
export function checkContentBudgets() {
  const problems = [];
  const skill = fs.readFileSync(path.join(SHARED_DIR, 'skill.md'), 'utf8');
  const onboard = fs.readFileSync(path.join(SHARED_DIR, 'onboard.md'), 'utf8');

  const desc = frontmatterDescription(skill);
  if (desc == null) {
    problems.push('skill.md has no frontmatter description');
  } else if (desc.length > BUDGETS.skillDescriptionChars) {
    problems.push(`skill.md description is ${desc.length} chars (budget ${BUDGETS.skillDescriptionChars}; /skills UI truncates)`);
  }

  const skillBodyLines = bodyAfterFrontmatter(skill).split('\n').length;
  if (skillBodyLines > BUDGETS.skillBodyLines) {
    problems.push(`skill.md body is ${skillBodyLines} lines (budget ${BUDGETS.skillBodyLines})`);
  }

  const onboardLines = onboard.split('\n').length;
  if (onboardLines > BUDGETS.onboardLines) {
    problems.push(`onboard.md is ${onboardLines} lines (budget ${BUDGETS.onboardLines})`);
  }

  return problems;
}

/** Compare .mcp.json ignoring only the mcpServers['squire-docs'].url field. */
function mcpMatchesIgnoringEndpoint(expected, actual) {
  let e;
  let a;
  try {
    e = JSON.parse(expected);
    a = JSON.parse(actual);
  } catch {
    return false;
  }
  const strip = (o) => {
    const c = JSON.parse(JSON.stringify(o));
    if (c?.mcpServers?.['squire-docs']) delete c.mcpServers['squire-docs'].url;
    return JSON.stringify(c);
  };
  return strip(e) === strip(a);
}

/**
 * @param {{ bundleDir?: string }} [opts]
 * @returns {{ ok: boolean, problems: string[], bundleDir: string }}
 */
export function checkBundleAgreement({ bundleDir = DEFAULT_BUNDLE_DIR } = {}) {
  const problems = [];
  const expected = expectedFiles({ endpoint: PROD_ENDPOINT });

  for (const [rel, expectedContent] of Object.entries(expected)) {
    const onDisk = path.join(bundleDir, rel);
    if (!fs.existsSync(onDisk)) {
      problems.push(`missing generated file: ${rel} (run: node test/first-run/assemble-bundle.mjs)`);
      continue;
    }
    const actual = fs.readFileSync(onDisk, 'utf8');
    if (rel === '.mcp.json') {
      if (!mcpMatchesIgnoringEndpoint(expectedContent, actual)) {
        problems.push(`.mcp.json diverges from shared/ (beyond the exempt endpoint field)`);
      }
      continue;
    }
    if (actual !== expectedContent) {
      problems.push(`${rel} diverges from distribution/shared/ — hand-edit the source, then re-assemble`);
    }
  }

  problems.push(...checkContentBudgets());
  return { ok: problems.length === 0, problems, bundleDir };
}

// CLI entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--bundle');
  const bundleDir = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : DEFAULT_BUNDLE_DIR;
  const { ok, problems } = checkBundleAgreement({ bundleDir });
  if (ok) {
    console.log(`✓ bundle agrees with distribution/shared/ (${path.relative(path.resolve(HERE, '../..'), bundleDir)})`);
    process.exit(0);
  }
  console.error(`✗ bundle drift detected:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
