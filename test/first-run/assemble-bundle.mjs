#!/usr/bin/env node
/**
 * Feature 030 US2 (T008, FR-019/020, RBD-1) — minimal rehearsal bundle assembler.
 *
 * Reads the canonical content in `distribution/shared/` and emits an installable
 * Claude Code plugin bundle the 029 rehearsal harness consumes via `--bundle`.
 *
 * This is DELIBERATELY NOT M3's `distribution/publish.mjs`: no mirror repos, no
 * submissions, no per-channel manifests, no registry entries. It lives under
 * `test/first-run/` so `distribution/` holds only `shared/` after this feature
 * (FR-020, RBD-1). The single source of truth is `distribution/shared/`; every
 * generated content file carries a do-not-hand-edit header pointing back at it,
 * and `check-bundle-agreement.mjs` fails on any drift.
 *
 * Usage:
 *   node test/first-run/assemble-bundle.mjs [--out <dir>] [--endpoint <url>]
 *
 * Programmatic (used by the agreement check + the harness):
 *   import { expectedFiles, assembleBundle, PROD_ENDPOINT, DEFAULT_BUNDLE_DIR } from './assemble-bundle.mjs'
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');
export const SHARED_DIR = path.join(REPO_ROOT, 'distribution', 'shared');
export const DEFAULT_BUNDLE_DIR = path.join(HERE, 'assembled-bundle');
export const PROD_ENDPOINT = 'https://squiredocs.com/mcp';

// Semver for the rehearsal bundle. Not the shipping version (that's M3); this
// only needs to be a valid semver so the plugin installs.
const BUNDLE_VERSION = '0.1.0';

/**
 * Insert a do-not-hand-edit header immediately AFTER any leading YAML
 * frontmatter (so the frontmatter stays first, which Claude Code requires),
 * else at the top. Byte-stable — the agreement check re-derives with this exact
 * transform.
 */
export function withGeneratedHeader(sharedContent, sourceRel) {
  const header =
    `<!-- GENERATED FILE — do not hand-edit. Source of truth: ${sourceRel}\n` +
    `     Regenerate with: node test/first-run/assemble-bundle.mjs -->\n`;
  const fm = sharedContent.match(/^---\n[\s\S]*?\n---\n/);
  if (fm) {
    return fm[0] + header + sharedContent.slice(fm[0].length);
  }
  return header + sharedContent;
}

function readShared(name) {
  return fs.readFileSync(path.join(SHARED_DIR, name), 'utf8');
}

const pluginJson = () =>
  JSON.stringify(
    {
      name: 'squire',
      version: BUNDLE_VERSION,
      description:
        'Squire Docs — the durable, attributed spec layer for agentic development. Sync your repo spec into a shared doc, then read it before every run and write status back after.',
      author: { name: 'Squire Docs' },
    },
    null,
    2,
  ) + '\n';

const marketplaceJson = () =>
  JSON.stringify(
    {
      name: 'squire-marketplace',
      owner: { name: 'Squire Docs' },
      metadata: {
        description:
          'Rehearsal marketplace for the Squire Docs plugin, assembled from distribution/shared/ for the first-run harness. Real distribution is M3.',
      },
      plugins: [
        {
          name: 'squire',
          source: './',
          description: 'Squire Docs — connect your coding agent and land your first spec in the loop.',
        },
      ],
    },
    null,
    2,
  ) + '\n';

const mcpJson = (endpoint) =>
  JSON.stringify(
    {
      mcpServers: {
        'squire-docs': { type: 'http', url: endpoint },
      },
    },
    null,
    2,
  ) + '\n';

/**
 * The full set of bundle files as { relativePath: content }, derived from
 * `distribution/shared/` + the manifest shapes above. The single source both
 * the writer (assembleBundle) and the drift guard (check-bundle-agreement)
 * compute from — so they cannot disagree.
 * @param {{ endpoint?: string }} [opts]
 */
export function expectedFiles({ endpoint = PROD_ENDPOINT } = {}) {
  return {
    '.claude-plugin/plugin.json': pluginJson(),
    '.claude-plugin/marketplace.json': marketplaceJson(),
    '.mcp.json': mcpJson(endpoint),
    'skills/squire/SKILL.md': withGeneratedHeader(readShared('skill.md'), 'distribution/shared/skill.md'),
    'commands/onboard.md': withGeneratedHeader(readShared('onboard.md'), 'distribution/shared/onboard.md'),
  };
}

/**
 * Write the bundle to outDir. Never mutates `distribution/shared/` (read-only).
 * @param {{ outDir?: string, endpoint?: string }} [opts]
 * @returns {{ outDir: string, files: string[] }}
 */
export function assembleBundle({ outDir = DEFAULT_BUNDLE_DIR, endpoint = PROD_ENDPOINT } = {}) {
  const files = expectedFiles({ endpoint });
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return { outDir, files: Object.keys(files) };
}

// CLI entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (name, fb) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fb;
  };
  const outDir = path.resolve(arg('--out', DEFAULT_BUNDLE_DIR));
  const endpoint = arg('--endpoint', PROD_ENDPOINT);
  const { files } = assembleBundle({ outDir, endpoint });
  console.log(`Assembled Squire Docs rehearsal bundle → ${outDir}`);
  for (const f of files) console.log(`  • ${f}`);
  console.log(`Endpoint: ${endpoint} (harness rewrites this per run; source distribution/shared/ untouched)`);
}
