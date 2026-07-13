#!/usr/bin/env node
// Sync ground-truth design docs from Squire into design/.
//
// Design changes are made IN SQUIRE first, then re-exported here, then code
// is converged to match. Never hand-edit the exported .md files — the next
// sync overwrites them. See .claude/skills/design-pipeline/SKILL.md.
//
// Usage:
//   SQUIRE_API_TOKEN=sk_sqd_... node design/sync.mjs
// The token needs documents:read scope. Sessions mint one via the Squire MCP
// create_access_token tool (max TTL 24h); a gitignored design/.squire-token
// file is read as a fallback so repeated runs within a day need no env var.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = process.env.SQUIRE_BASE_URL || 'https://squiredocs.com';

// guid → repo-relative filename under design/. Keep in step with the
// "Squire Design Docs — Index" doc (design/index.md).
const DOCS = {
  'f8f3a2ee-31bb-4d80-8306-25e186810885': 'index.md',
  'b6edb804-cf72-416d-9c97-063a23e669c0': 'markdown-import-two-way-sync.md',
};

const designDir = dirname(fileURLToPath(import.meta.url));

function getToken() {
  if (process.env.SQUIRE_API_TOKEN) return process.env.SQUIRE_API_TOKEN.trim();
  const tokenFile = join(designDir, '.squire-token');
  if (existsSync(tokenFile)) return readFileSync(tokenFile, 'utf8').trim();
  console.error(
    'No token. Set SQUIRE_API_TOKEN or write design/.squire-token (gitignored).\n' +
    'Mint one with the Squire MCP create_access_token tool (documents:read).'
  );
  process.exit(1);
}

const token = getToken();
let failures = 0;

for (const [guid, filename] of Object.entries(DOCS)) {
  const url = `${BASE_URL}/api/docs/${guid}/export?format=markdown`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.error(`FAIL ${filename}: ${res.status} ${res.statusText} (${guid})`);
    failures++;
    continue;
  }
  const markdown = await res.text();
  const header =
    `<!-- source: ${BASE_URL}/d/${guid}\n` +
    `     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->\n\n`;
  writeFileSync(join(designDir, filename), header + markdown);
  console.log(`ok   ${filename}`);
}

process.exit(failures ? 1 : 0);
