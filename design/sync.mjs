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
// Repo Sync Manifest in the "Squire Architecture Design Index" doc
// (design/index.md) — this map is what the sync executes.
const DOCS = {
  'f7476460-5c97-422d-bf5f-ef0c4a1ad048': 'index.md',
  'b6edb804-cf72-416d-9c97-063a23e669c0': 'markdown-import-two-way-sync.md',
  '396c4ec7-9db5-4f91-b0c6-8c5faa9f0f65': 'collaboration-core.md',
  '6e425e03-1670-4773-987a-584d3d04dea3': 'document-model-format-pipeline.md',
  '697456a2-b42b-49b3-ae57-875d3e328809': 'agent-surface-mcp.md',
  '75b5055d-f4f8-4b3c-8955-f6c3f7841fc7': 'in-app-ai-assistant.md',
  '503fb6a8-d165-49c7-bc98-883a68b14540': 'authentication-and-sharing.md',
  '187b0da3-1004-4273-82f8-062f6a903f14': 'content-search.md',
  '9bb17cdc-0b56-4c87-8b4e-d3686029cb8a': 'media-and-diagram-blocks.md',
  'c97e58df-4104-4e5d-8ab6-711a7b115696': 'infrastructure-and-environments.md',
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
