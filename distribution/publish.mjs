#!/usr/bin/env node
/**
 * distribution/publish.mjs — M3 wave-1 single generator / validator / (Sam-run) pusher.
 *
 * ONE generator, ONE drift guard, ONE import surface. Regenerates every wave-1
 * distribution bundle from the canonical `distribution/shared/` content, validates
 * each generated manifest against a pinned in-repo JSON schema, and — only behind an
 * explicit `--publish` flag plus externally-configured mirror remotes — pushes the
 * generated bundles to their public mirror repos. It replaces the retired M2
 * assembler (`test/first-run/assemble-bundle.mjs` + agreement check).
 *
 * VALIDATOR (T002 probe, 2026-07-22; re-confirmed 033 T002, 2026-07-23): `ajv` is
 * NOT resolvable in this repo's dependency tree (`node -e "require.resolve('ajv')"`
 * throws). Per research R8 this script therefore uses the self-contained STRUCTURAL
 * validator below — no new production dependency. The pinned schemas under
 * `distribution/schemas/` are the documented contract that validator is written
 * against (see schemas/SOURCES.md). The wave-2 Cursor/Kiro/`.mdc` validators
 * (`validateCursorPlugin`, `validateCursorMcp`, `validateKiroPower`,
 * `validateMdcRule`) are ALSO the self-contained structural kind — no new
 * production dependency (FR-021). The Cursor validator derives its allowed
 * top-level keys from the vendored `cursor-plugin.schema.json` `properties` so its
 * `additionalProperties:false` intent tracks the vendored schema.
 *
 * SECURITY POSTURE (constitution V — highest-risk area; analyze escalates violations to HIGH):
 *   1. Default invocation is DRY-RUN: regenerate + validate only. NO network, NO
 *      credentials, NO side effects. Pushing requires BOTH `--publish` AND mirror
 *      remotes supplied via config/environment (never a committed default); missing
 *      or unreachable remotes fail CLOSED before any push (INV-1, RBD-6).
 *   2. The committed bundle ships NO dev endpoint: the generated `.mcp.json` url is
 *      always PROD_ENDPOINT; the dev-endpoint rewrite lives only in the rehearsal
 *      harness's throwaway copy, never here (INV-2).
 *   3. `expectedFiles` / `expectedRegistryServer` are PURE (no disk write) and are
 *      the ONLY source of expected bytes the drift test imports (INV-3).
 *
 * USAGE:
 *   node distribution/publish.mjs                 # dry-run: regenerate committed bundles + validate (default)
 *   node distribution/publish.mjs --out <dir>     # materialize into <dir> instead of the committed tree
 *   node distribution/publish.mjs --endpoint <url># local materialization with a different endpoint (dev only)
 *   node distribution/publish.mjs --publish       # push mode — fails closed unless mirror remotes are configured
 *
 * PUBLISH (Sam op, FR-028) — the exact first-real-publish invocation:
 *   SQUIRE_MIRROR_CLAUDE_PLUGIN=git@github.com:squiredocs/squire-plugin.git \
 *   SQUIRE_MIRROR_MCP_REGISTRY=git@github.com:squiredocs/squire-mcp-registry.git \
 *     node distribution/publish.mjs --publish
 *   Per mirror: clone/fetch → version-bump guard (refuse content-change-without-version-bump)
 *   → commit + push with a message referencing this repo's HEAD commit. Tests exercise the
 *   push mechanism against LOCAL BARE-REPO FIXTURES ONLY — never a real remote (RBD-6).
 *
 * SCHEMA REFRESH: see distribution/schemas/SOURCES.md (re-fetch + diff + bump).
 *
 * Programmatic exports (the harness + the drift test import these — contracts/publish-api.md):
 *   PROD_ENDPOINT, withGeneratedHeader, expectedFiles, assembleBundle,
 *   DEFAULT_CLAUDE_PLUGIN_DIR, CHANNELS, expectedRegistryServer, validateBundles
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const SHARED_DIR = path.join(REPO_ROOT, 'distribution', 'shared');
export const SCHEMAS_DIR = path.join(REPO_ROOT, 'distribution', 'schemas');
export const DEFAULT_CLAUDE_PLUGIN_DIR = path.join(REPO_ROOT, 'distribution', 'claude-plugin');
export const DEFAULT_MCP_REGISTRY_DIR = path.join(REPO_ROOT, 'distribution', 'mcp-registry');
// Wave-2 channel output dirs (FR-016). Each new channel is a committed bundle dir.
export const DEFAULT_KIRO_POWER_DIR = path.join(REPO_ROOT, 'distribution', 'kiro-power');
export const DEFAULT_CURSOR_PLUGIN_DIR = path.join(REPO_ROOT, 'distribution', 'cursor-plugin');

// Server keys (the `mcpServers` key + the manifest `name` + the deeplink `name`).
// RBD-1: both wave-2 channels use `squire-docs`; the wave-1 claude-plugin key
// stays `squire` (bound to `/squire:...` command namespacing + the agents.md
// one-liner). These are identifiers, not user-facing copy.
export const CURSOR_SERVER_KEY = 'squire-docs';
export const KIRO_SERVER_KEY = 'squire-docs';

// Wave-2 shipped versions. Each channel versions INDEPENDENTLY — a change to one
// must not force a no-op bump (and republish) of any other (FR-016). Both start at
// 1.0.0 (first publish). Kiro's carrier is POWER.md frontmatter `version:` (RBD-2);
// Cursor's is `.cursor-plugin/plugin.json` `version`.
export const KIRO_POWER_VERSION = '1.0.0';
export const CURSOR_PLUGIN_VERSION = '1.0.0';

// The one shipping endpoint. The committed `.mcp.json` always hardcodes this;
// only the rehearsal harness rewrites it (in a throwaway copy) for the dev server.
export const PROD_ENDPOINT = 'https://squiredocs.com/mcp';

// Shipped versions. The design's bump-on-any-change rule: any change to a
// channel's generated content requires bumping that channel's version (the
// publish version guard refuses an unchanged version with changed content).
//
// The two channels version INDEPENDENTLY — a change to one must not force a
// no-op version bump (and a republish) of the other. SHIP_VERSION is the Claude
// plugin; REGISTRY_VERSION is the MCP-registry server.json.
//   plugin  1.0.0 initial · 1.0.1 add MIT LICENSE
//   registry 1.0.0 initial · 1.0.1 add MIT LICENSE · 1.0.2 migrate to the
//            2025-12-11 registry schema (plugin unchanged at 1.0.1)
export const SHIP_VERSION = '1.0.1';
export const REGISTRY_VERSION = '1.0.2';

// MIT license, generated into every published bundle so the mirrors carry it
// (they are generated-only — a hand-added LICENSE would be pruned on publish).
// Copyright holder + year here are the single source of truth.
const LICENSE_YEAR = '2026';
const LICENSE_HOLDER = 'Squire Docs';
function licenseText() {
  return `MIT License

Copyright (c) ${LICENSE_YEAR} ${LICENSE_HOLDER}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

// The pinned Official MCP Registry schema this server.json is authored against.
const REGISTRY_SCHEMA_URL =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

/**
 * Insert the do-not-hand-edit header immediately AFTER any leading YAML
 * frontmatter (so the frontmatter stays first — Claude Code requires it), else at
 * the top. Byte-stable: the drift test re-derives with this exact transform.
 * [M2 — carried verbatim from assemble-bundle.mjs lines 41-50; only the regen
 * command string changes to `node distribution/publish.mjs`.]
 */
export function withGeneratedHeader(sharedContent, sourceRel) {
  const header =
    `<!-- GENERATED FILE — do not hand-edit. Source of truth: ${sourceRel}\n` +
    `     Regenerate with: node distribution/publish.mjs -->\n`;
  const fm = sharedContent.match(/^---\n[\s\S]*?\n---\n/);
  if (fm) {
    return fm[0] + header + sharedContent.slice(fm[0].length);
  }
  return header + sharedContent;
}

function readShared(name) {
  return fs.readFileSync(path.join(SHARED_DIR, name), 'utf8');
}

/**
 * The Add-to-Cursor deeplink (FR-019, research R6). PURE — no disk, no network.
 * Derived from `PROD_ENDPOINT` (never a second hardcoded URL): the `config` query
 * param is base64 of `JSON.stringify({ url: endpoint })`, exactly the inner Cursor
 * MCP server object. For the prod endpoint the config is
 * `eyJ1cmwiOiJodHRwczovL3NxdWlyZWRvY3MuY29tL21jcCJ9`. The site surfaces embed this
 * output byte-identically; the round-trip test decodes it back to `{url: PROD_ENDPOINT}`.
 * @param {{ name?: string, endpoint?: string }} [opts]
 * @returns {string}
 */
export function cursorDeeplink({ name = CURSOR_SERVER_KEY, endpoint = PROD_ENDPOINT } = {}) {
  const config = Buffer.from(JSON.stringify({ url: endpoint })).toString('base64');
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${name}&config=${config}`;
}

// --- Claude-plugin manifest derivations (production copy — no rehearsal framing) ---

const pluginJson = () =>
  JSON.stringify(
    {
      name: 'squire',
      version: SHIP_VERSION,
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
          'The official marketplace for the Squire Docs plugin — connect your coding agent to the durable, attributed spec layer for agentic development.',
      },
      plugins: [
        {
          name: 'squire',
          source: './',
          description:
            'Squire Docs — connect your coding agent and land your first spec in the repo, doc, and agent loop.',
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
        // Server key MUST be `squire` (FR-004): it matches the name the served
        // agents.md / Agent Surface doc use in the `claude mcp add … squire`
        // one-liner and that onboard.md tells the user to pick in `/mcp`.
        squire: { type: 'http', url: endpoint },
      },
    },
    null,
    2,
  ) + '\n';

/**
 * The full claude-plugin bundle as { relativePath: content } — the single source
 * both the writer (assembleBundle) and the drift guard compute from, so they
 * cannot disagree. PURE: no disk write. Deterministic (FR-008): identical
 * `shared/` inputs → byte-identical outputs.
 * @param {{ endpoint?: string }} [opts]
 */
export function expectedFiles({ endpoint = PROD_ENDPOINT } = {}) {
  return {
    '.claude-plugin/plugin.json': pluginJson(),
    '.claude-plugin/marketplace.json': marketplaceJson(),
    '.mcp.json': mcpJson(endpoint),
    'skills/squire/SKILL.md': withGeneratedHeader(readShared('skill.md'), 'distribution/shared/skill.md'),
    'commands/onboard.md': withGeneratedHeader(readShared('onboard.md'), 'distribution/shared/onboard.md'),
    'LICENSE': licenseText(),
  };
}

/**
 * Write the claude-plugin bundle to outDir. Never mutates `distribution/shared/`
 * (read-only, FR-006). Used by the harness to materialize a bundle and by
 * `--publish` to stage a mirror.
 * @param {{ outDir?: string, endpoint?: string }} [opts]
 * @returns {{ outDir: string, files: string[] }}
 */
export function assembleBundle({ outDir = DEFAULT_CLAUDE_PLUGIN_DIR, endpoint = PROD_ENDPOINT } = {}) {
  const files = expectedFiles({ endpoint });
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return { outDir, files: Object.keys(files) };
}

/**
 * The deterministic Official MCP Registry server.json content (FR-007, RBD-7):
 * reverse-DNS `com.squiredocs/mcp`, remote streamable-HTTP endpoint, OAuth posture
 * declared under the schema-sanctioned publisher-provided _meta extension (the
 * registry format has no dedicated OAuth field — remote MCP OAuth is discovered
 * via the well-known chain), version mirroring SHIP_VERSION, NO package/stdio.
 * PURE: no disk write. Drift-matched.
 * @returns {string}
 */
export function expectedRegistryServer() {
  return (
    JSON.stringify(
      {
        $schema: REGISTRY_SCHEMA_URL,
        name: 'com.squiredocs/mcp',
        description: 'Squire Docs — the durable, attributed spec layer for agentic development.',
        version: REGISTRY_VERSION,
        websiteUrl: 'https://squiredocs.com',
        remotes: [
          {
            type: 'streamable-http',
            url: PROD_ENDPOINT,
          },
        ],
        _meta: {
          'io.modelcontextprotocol.registry/publisher-provided': {
            // Remote OAuth is discovered via the server's well-known chain
            // (RFC 9728); recorded here for transparency. No stdio/package artifact.
            authentication: 'oauth2',
          },
        },
      },
      null,
      2,
    ) + '\n'
  );
}

// --- Kiro Power derivations (wave 2, FR-001..008) ----------------------------
// Fully generated from the same product truth as shared/, reframed Kiro-native:
// the .kiro/specs files Kiro users already generate, hosted as a shared, attributed,
// two-way-synced Squire Docs document. Own version (KIRO_POWER_VERSION), independent.

const KIRO_KEYWORDS = [
  'specs', 'spec-driven', 'kiro-specs', 'requirements', 'design',
  'review', 'attribution', 'version-history', 'squire', 'docs',
];

function kiroPowerMd(endpoint) {
  const frontmatter =
    '---\n' +
    'name: "squire-docs"\n' +
    'displayName: "Squire Docs — collaborative specs"\n' +
    'description: "The durable, attributed spec layer for spec-driven development — two-way sync between your .kiro/specs files and a live Squire Docs document your team edits together."\n' +
    `keywords: ${JSON.stringify(KIRO_KEYWORDS)}\n` +
    'author: "Squire Docs"\n' +
    `version: "${KIRO_POWER_VERSION}"\n` +
    '---\n';
  const body = `# Squire Docs

## Overview

Squire Docs is the durable, attributed spec layer for spec-driven development. The requirements, design, and status your team works from live in a Squire Docs document where every edit — human or agent — is attributed and revertible, and teammates and other agents all see the same doc. This Power connects Kiro to that document over MCP and holds the loop that keeps your \`.kiro/specs\` files and the shared doc in sync, both directions.

## When to Use This Power

Reach for Squire Docs when a spec in this workspace should be reviewable in a place a teammate — a product manager, a designer, another agent — can edit; when you want the spec Kiro plans and implements against to be a living document your whole team signs off on; or when you and the user are iterating together on a requirements or design doc. Kiro's spec-driven workflow is a natural fit: the \`.kiro/specs\` files you already generate become a shared, attributed, two-way-synced Squire Docs document.

## Onboarding

First run in a workspace: get connected, sync the first spec, and hand back the doc URL.

1. **Connect.** The \`squire-docs\` MCP server uses OAuth — Kiro opens your browser to sign in on the first tool call. Signing in with Google is find-or-create: if you do not have a Squire Docs account yet, that same click creates it and connects Kiro, with no separate signup step. (See MCP Configuration below.)
2. **Find the spec.** Look for a spec-shaped artifact in this workspace, in order of precedence: \`.kiro/specs/**\`, then \`specs/**\`, then \`PLAN.md\` or \`docs/plan.md\`, then \`CLAUDE.md\`. Offer the best candidate and let the user confirm; if nothing spec-shaped exists, offer to draft a starter spec from the repo's README and structure.
3. **Sync it byte-faithfully.** Move the chosen file over Squire Docs' REST byte channel — never retype its content through a tool parameter, even after you have read it. Call \`import_markdown_file\` and run the recipe it returns: one shell command that claims a token, imports the file over REST (frontmatter preserved), and writes a sync receipt back into the file. You only set its \`FILE=\` line.
4. **Deliver the payoff.** Print the new doc's URL exactly as the sync receipt states it (\`View it at …/d/<docGuid>\`). The editor is where the human reviews and refines the spec, every edit attributed and revertible — the payoff inside the loop, not a front door the user must visit first.
5. **Teach the loop.** State the standing behavior: read the spec from the doc before each run, write status and design back after. The loop is detailed in \`steering/specs-sync-workflow.md\`.

## Available Steering Files

- \`steering/working-with-squire-docs.md\` — what a Squire Docs document is: two-way sync, attribution, revertibility, and why hosting your \`.kiro/specs\` there is the hero move.
- \`steering/specs-sync-workflow.md\` — the standing sync loop, the REST byte channel for file content, and the \`sk_sqd_\` token-handling rules.

## When to Load Steering Files

- When syncing a spec into Squire Docs, or setting up the workspace for the first time → load \`steering/specs-sync-workflow.md\`.
- When explaining what the shared document gives the team, or deciding whether to host a spec there → load \`steering/working-with-squire-docs.md\`.
- When moving file content or a token in or out of Squire Docs → load \`steering/specs-sync-workflow.md\` (the byte channel and token rules).

## Available MCP Servers

- \`squire-docs\` — the Squire Docs MCP server at \`${endpoint}\`. It exposes tools to list, create, read, share, and edit documents, work with version history, and mint scoped access tokens. Agents call \`get_tool_documentation\` for the full scripting reference before writing their first \`modify\` script.

## MCP Configuration

The \`mcp.json\` in this Power registers the server:

\`\`\`json
{
  "mcpServers": {
    "squire-docs": {
      "type": "http",
      "url": "${endpoint}",
      "disabled": false,
      "autoApprove": []
    }
  }
}
\`\`\`

Authentication is automatic: Squire Docs supports Dynamic Client Registration, so Kiro self-registers and runs the browser OAuth flow on first use — there are no client IDs or secrets to set by hand, which is why this config carries no \`oauth\` block. Reading requires the \`documents:read\` scope and writing requires \`documents:write\`; an agent only ever acts within the roles your account has granted.

## License and Support

- This Power is licensed **MIT** — you are free to fork and adapt the Power itself. The hosted Squire Docs service it connects to is a paid product, not open source.
- Privacy policy: https://squiredocs.com/privacy
- Support: hello@squiredocs.com
`;
  return withGeneratedHeader(frontmatter + body, 'distribution/publish.mjs');
}

const kiroMcpJson = (endpoint) =>
  JSON.stringify(
    {
      mcpServers: {
        'squire-docs': { type: 'http', url: endpoint, disabled: false, autoApprove: [] },
      },
    },
    null,
    2,
  ) + '\n';

function kiroSteeringWorking() {
  return `# Working with Squire Docs

Squire Docs is the durable, attributed spec layer for spec-driven development. The spec, design, and status your team works from live in a Squire Docs document where every edit — human or agent — is attributed and revertible, and teammates and other agents all see the same doc.

For a Kiro workspace the hero move is simple: the \`.kiro/specs\` files you already generate become a shared, attributed, two-way-synced Squire Docs document. The spec Kiro plans and implements against stops being a file only one person can see and becomes something a product manager or designer can open, review, and refine — with every change tracked.

## What the document gives you

- **Two-way sync.** A spec stays in sync between your \`.kiro/specs\` file and its Squire Docs doc. Edit in either place; a push from the repo merges like an edit from a collaborator who was offline — attribution intact, no conflict dialogs.
- **Attribution.** Every edit is attributed to whoever, or whatever, made it. An agent is a collaborator, not a hidden write path: while it works it appears as a live cursor named "AgentName (UserName)", and its edits show up in version history alongside everyone else's. There is no separate, unattributed way to change the document.
- **Revertibility.** Every change lives in version history and can be reviewed, named, compared, and restored. Nothing is lost, and no edit is anonymous.

## Why host your spec here

A spec sitting untracked in \`.kiro/specs\` is visible to one person on one machine. Synced into Squire Docs it becomes a durable, shared, attributed home for the spec — the place the team signs off on requirements and design, and the source of truth your next run reads from. The loop in \`steering/specs-sync-workflow.md\` is what keeps it current.
`;
}

function kiroSteeringSyncWorkflow() {
  return `# The Squire Docs sync loop

Once a workspace's spec is synced into Squire Docs, hold this loop on every run. It is what makes the doc worth having: the doc stays current because the loop keeps it current, and every change is attributed.

## The standing loop

- **Sync before a run.** If the repo's spec file changed since it was last synced, sync it into its Squire Docs doc first, so the doc reflects what is in the repo. (First time in a workspace, work the Onboarding steps in \`POWER.md\` — find the spec, connect, and create the doc.)
- **Read at the start.** Read the spec from the doc at the start of the run. It is the source of truth the team edits, and it may carry human refinements that never landed back in the repo file.
- **Write back after.** After implementing, write status and design decisions back to the doc: what shipped, what changed, what is still open. The next run — yours, a teammate's, or another agent's — then starts from an accurate spec.

## The byte channel: never retype file content

Content that already exists as bytes outside the model — a file on disk, another tool's output — moves over Squire Docs' REST byte channel, not through tool parameters. This holds even after you have read the file: reading it into context does not make retyping it correct. Retyping risks silent corruption and passes content through the model that never needed to travel there.

- **Into Squire Docs:** call \`import_markdown_file\` and run the recipe it returns — one shell command that claims a token, imports the file over REST (frontmatter preserved), and writes a sync receipt back. You only set its \`FILE=\` line. Do not read the file and paste its content into a create call.
- **Out of Squire Docs:** \`GET /api/docs/:docId/export?format=markdown\` serializes the persisted doc, no client connection needed. Pair it with \`list_documents\`' \`updatedSince\` for incremental pulls.

When you are unsure which tool fits, call \`get_tool_documentation\` — it carries the full REST reference the tool descriptions are too small to hold.

## Tokens live in a file, never in the transcript

An \`sk_sqd_\` API token is a secret, and a secret is bytes outside the model: it moves Settings → disk → \`Authorization\` header, never through the conversation.

- Keep the token in \`~/.squire/token\`, a \`0600\` file.
- Reference it — \`$(cat ~/.squire/token)\` — and never print, echo, or paste the raw value, and never put it on a command line as an argument (argv leaks into shell history and process lists).
- When an agent mints its own token, \`create_access_token\` returns a one-shot claim recipe that writes the bytes straight to disk; the token itself never enters the transcript.

Context carries only what the model created or transformed — never a credential, and never file content that already exists as bytes.
`;
}

/**
 * The full Kiro Power bundle as { relativePath: content }. PURE, deterministic.
 * @param {{ endpoint?: string }} [opts]
 */
export function kiroPowerFiles({ endpoint = PROD_ENDPOINT } = {}) {
  return {
    'POWER.md': kiroPowerMd(endpoint),
    'mcp.json': kiroMcpJson(endpoint),
    'steering/specs-sync-workflow.md': withGeneratedHeader(kiroSteeringSyncWorkflow(), 'distribution/publish.mjs'),
    'steering/working-with-squire-docs.md': withGeneratedHeader(kiroSteeringWorking(), 'distribution/publish.mjs'),
  };
}

// --- Cursor plugin derivations (wave 2, FR-009..014) -------------------------
// Fully generated from shared/ + channel-specific manifests. Cursor REQUIRES OSS,
// so the bundle ships the same single-source MIT LICENSE as wave 1. Own version
// (CURSOR_PLUGIN_VERSION), independent. Cursor's mcp.json uses a BARE url (no type).

const CURSOR_KEYWORDS = ['spec', 'spec-driven', 'mcp', 'collaboration', 'design-docs'];

const cursorPluginJson = () =>
  JSON.stringify(
    {
      name: CURSOR_SERVER_KEY,
      displayName: 'Squire Docs',
      version: CURSOR_PLUGIN_VERSION,
      description:
        "The durable, attributed spec layer for agentic development — two-way sync between your repo's spec files and a live Squire Docs document your team edits together.",
      author: { name: 'Squire Docs', email: 'hello@squiredocs.com' },
      homepage: 'https://squiredocs.com',
      repository: 'https://github.com/squiredocs/squire-cursor-plugin',
      license: 'MIT',
      keywords: CURSOR_KEYWORDS,
      category: 'Developer Tools',
    },
    null,
    2,
  ) + '\n';

// Cursor convention: a BARE `url` means remote streamable-HTTP — there is NO `type`
// field (FR-011). DCR handles OAuth, so no `auth` block either.
const cursorMcpJson = (endpoint) =>
  JSON.stringify(
    { mcpServers: { 'squire-docs': { url: endpoint } } },
    null,
    2,
  ) + '\n';

function cursorRuleMdc() {
  const content = `---
description: Use when working from a spec/design doc in this repo — keep the Squire Docs spec and the repo in sync (read before a run, write status back after).
alwaysApply: false
---
# Squire Docs spec loop

- Sync the repo's spec into its Squire Docs doc before a run if it changed.
- Read the spec from the doc at run start — it may carry human refinements not yet in the repo file.
- After implementing, write status and design decisions back: what shipped, what changed, what's open. Every edit is attributed and revertible; the next run starts from an accurate spec.
- Move file content over Squire Docs' REST byte channel (run the recipe \`import_markdown_file\` returns), never by retyping it — even after you have read the file.
- Keep an \`sk_sqd_\` token in \`~/.squire/token\` (a \`0600\` file), reference it as \`$(cat ~/.squire/token)\`, and never paste the raw value into the transcript.
`;
  // The rule text above is authored inline HERE, not in shared/skill.md — stamp the
  // real source so a maintainer edits the right file (033 review LOW).
  return withGeneratedHeader(content, 'distribution/publish.mjs');
}

function cursorReadme() {
  const content = `# Squire Docs — Cursor plugin

Squire Docs is the durable, attributed spec layer for spec-driven development. This plugin connects Cursor to your team's Squire Docs documents over MCP, and adds a spec-loop rule and a skill that keep your repo's spec files and the shared doc in sync, both directions.

## What installing this does

- **Registers the Squire Docs MCP server** (\`mcp.json\`) at \`https://squiredocs.com/mcp\`, so Cursor's agent can list, read, create, share, and edit your documents and work with version history.
- **Adds the \`squire-spec-loop\` rule** (\`rules/squire-spec-loop.mdc\`) — an Agent-Requested rule that reminds the agent to sync before a run, read the spec from the doc, and write status back after.
- **Adds the \`squire\` skill** (\`skills/squire/SKILL.md\`) — the full working-with-Squire-Docs guidance: the standing loop, the REST byte channel for file content, and the \`sk_sqd_\` token-handling rules.

## First use: signing in

The server uses OAuth. On the first tool call Cursor opens your browser to sign in — Squire Docs supports Dynamic Client Registration, so there are no client IDs or secrets to set by hand. Signing in with Google is find-or-create: if you do not have a Squire Docs account yet, that same click creates it and connects Cursor, with no separate signup step. Reading requires the \`documents:read\` scope and writing requires \`documents:write\`; the agent only ever acts within the roles your account has granted.

## Where the ground truth lives

This bundle is generated from the Squire Docs source repository — do not hand-edit it or open pull requests against this mirror. Fixes land upstream and are regenerated here. The plugin itself is MIT-licensed; the hosted Squire Docs service it connects to is a paid product.
`;
  return withGeneratedHeader(content, 'distribution/publish.mjs');
}

// The shared skill names Claude Code's `/squire:onboard` command for first-run doc
// creation. The Cursor plugin ships NO commands, so porting that clause verbatim would
// tell a Cursor user to run a command that does not exist (033 review MEDIUM). Rewrite
// exactly that clause to channel-neutral wording; every other byte is the shared source
// (so the Claude bundle's wave-1 bytes are untouched — we transform the port, not
// shared/skill.md). The throw is a drift tripwire: if the shared wording changes, the
// port fails loudly instead of silently shipping the stale Claude-ism.
const CURSOR_ONBOARD_CLAUSE = '(First time in a repo, run `/squire:onboard` — it finds the spec and creates the doc.)';
const CURSOR_ONBOARD_NEUTRAL = '(First time in a repo, create its Squire Docs doc from the spec, then keep the two in sync.)';
function cursorSkillPort() {
  const shared = readShared('skill.md');
  const ported = shared.replace(CURSOR_ONBOARD_CLAUSE, CURSOR_ONBOARD_NEUTRAL);
  if (ported === shared) {
    throw new Error(
      'cursor skill port: the `/squire:onboard` clause was not found in shared/skill.md — '
      + 'its wording changed; update CURSOR_ONBOARD_CLAUSE so the Cursor port stays command-free.',
    );
  }
  return withGeneratedHeader(ported, 'distribution/shared/skill.md');
}

/**
 * The full Cursor plugin bundle as { relativePath: content }. PURE, deterministic.
 * SKILL.md is shared/skill.md ported for Cursor (Claude-command clause neutralized,
 * + generated header), FR-013.
 * @param {{ endpoint?: string }} [opts]
 */
export function cursorPluginFiles({ endpoint = PROD_ENDPOINT } = {}) {
  return {
    '.cursor-plugin/plugin.json': cursorPluginJson(),
    'mcp.json': cursorMcpJson(endpoint),
    'rules/squire-spec-loop.mdc': cursorRuleMdc(),
    'skills/squire/SKILL.md': cursorSkillPort(),
    'LICENSE': licenseText(),
    'README.md': cursorReadme(),
  };
}

// --- Version carriers (FR-017 — security-load-bearing) -----------------------
// Each channel declares HOW to read its own version from its {rel:content} file
// map, so the publish version-bump guard reads the right carrier per channel
// WITHOUT a hardcoded per-id branch. `readVersion` is TOTAL: it returns a semver
// string or THROWS (an absent/malformed carrier is never silently a version). The
// guard applies the SAME `readVersion` to both the fresh in-memory map and the
// mirror map read from disk, and treats a throw on the mirror side as
// "present-but-unreadable → refuse", never "first publish". Kiro has no JSON
// manifest — its version rides in POWER.md YAML frontmatter (RBD-2).

/** Version carrier for a JSON manifest: files => JSON.parse(files[rel]).version. */
export function versionFromJson(rel) {
  return (files) => {
    const raw = files[rel];
    if (typeof raw !== 'string') throw new Error(`version carrier ${rel} absent`);
    const v = JSON.parse(raw).version;
    if (typeof v !== 'string' || !v) throw new Error(`version carrier ${rel} has no version`);
    return v;
  };
}

/** Version carrier for a YAML-frontmatter file (e.g. POWER.md `version:`). */
export function versionFromFrontmatter(rel, key = 'version') {
  return (files) => {
    const raw = files[rel];
    if (typeof raw !== 'string') throw new Error(`version carrier ${rel} absent`);
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fm) throw new Error(`version carrier ${rel} has no YAML frontmatter`);
    // Match `key: "1.0.0"` or `key: 1.0.0` (quoted or bare), a single line.
    const m = fm[1].match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm'));
    if (!m) throw new Error(`version carrier ${rel} frontmatter has no ${key}:`);
    const v = m[1].trim();
    if (!v) throw new Error(`version carrier ${rel} frontmatter ${key} is empty`);
    return v;
  };
}

// --- Channel registry (RBD-3) ------------------------------------------------
// A list of channel descriptors so wave-2/3 channels (033+) add a descriptor
// rather than a rearchitecture. Wave 1 wires `claude-plugin` + `mcp-registry`;
// wave 2 (033) appends `kiro-power` + `cursor-plugin`. Each descriptor:
//   id                — stable channel id.
//   outDir            — committed output directory (absolute).
//   files()           — () → { relPath: content } pure map of every generated file.
//   endpointRel       — (optional) the rel path whose endpoint field is drift-exempt.
//   schema            — pinned schema binding: { file, kind } (kind selects the
//                       structural validator; `manifestRel` names which generated
//                       file the schema validates within this channel).
//   mirrorEnv         — env var name that supplies this channel's push remote (never
//                       a committed default — fail-closed, INV-1).
//   readVersion(files)— (FR-017) total version carrier: semver string or throws.
//   versionCarrierRel — human label of the version-bearing file (refusal messages).
export const CHANNELS = [
  {
    id: 'claude-plugin',
    outDir: DEFAULT_CLAUDE_PLUGIN_DIR,
    files: ({ endpoint = PROD_ENDPOINT } = {}) => expectedFiles({ endpoint }),
    endpointRel: '.mcp.json',
    schemas: [
      { manifestRel: '.claude-plugin/plugin.json', file: 'plugin.schema.json', kind: 'plugin' },
      { manifestRel: '.claude-plugin/marketplace.json', file: 'marketplace.schema.json', kind: 'marketplace' },
      { manifestRel: '.mcp.json', file: null, kind: 'mcp' },
    ],
    mirrorEnv: 'SQUIRE_MIRROR_CLAUDE_PLUGIN',
    readVersion: versionFromJson('.claude-plugin/plugin.json'),
    versionCarrierRel: '.claude-plugin/plugin.json',
  },
  {
    id: 'mcp-registry',
    outDir: DEFAULT_MCP_REGISTRY_DIR,
    files: () => ({ 'server.json': expectedRegistryServer(), 'LICENSE': licenseText() }),
    endpointRel: null,
    schemas: [{ manifestRel: 'server.json', file: 'server.schema.json', kind: 'registry' }],
    mirrorEnv: 'SQUIRE_MIRROR_MCP_REGISTRY',
    readVersion: versionFromJson('server.json'),
    versionCarrierRel: 'server.json',
  },
  {
    id: 'kiro-power',
    outDir: DEFAULT_KIRO_POWER_DIR,
    files: ({ endpoint = PROD_ENDPOINT } = {}) => kiroPowerFiles({ endpoint }),
    endpointRel: 'mcp.json',
    // Kiro's POWER.md is not JSON — its validator takes the whole file map (FILES_KINDS).
    schemas: [{ manifestRel: 'POWER.md', file: null, kind: 'kiro-power' }],
    mirrorEnv: 'SQUIRE_MIRROR_KIRO_POWER',
    readVersion: versionFromFrontmatter('POWER.md'),
    versionCarrierRel: 'POWER.md',
  },
  {
    id: 'cursor-plugin',
    outDir: DEFAULT_CURSOR_PLUGIN_DIR,
    files: ({ endpoint = PROD_ENDPOINT } = {}) => cursorPluginFiles({ endpoint }),
    endpointRel: 'mcp.json',
    schemas: [
      { manifestRel: '.cursor-plugin/plugin.json', file: 'cursor-plugin.schema.json', kind: 'cursor-plugin' },
      { manifestRel: 'mcp.json', file: null, kind: 'cursor-mcp' },
      { manifestRel: 'rules/squire-spec-loop.mdc', file: null, kind: 'mdc-rule' },
    ],
    mirrorEnv: 'SQUIRE_MIRROR_CURSOR_PLUGIN',
    readVersion: versionFromJson('.cursor-plugin/plugin.json'),
    versionCarrierRel: '.cursor-plugin/plugin.json',
  },
];

/**
 * Write every channel's files into its committed outDir (or a mirror of
 * outDirs via `outRoot`). Never mutates `distribution/shared/`.
 * @param {{ endpoint?: string, outRoot?: string }} [opts]
 * @returns {{ id: string, outDir: string, files: string[] }[]}
 */
export function generateAll({ endpoint = PROD_ENDPOINT, outRoot = null } = {}) {
  const out = [];
  for (const ch of CHANNELS) {
    const outDir = outRoot ? path.join(outRoot, ch.id) : ch.outDir;
    const files = ch.files({ endpoint });
    for (const [rel, content] of Object.entries(files)) {
      const dest = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
    out.push({ id: ch.id, outDir, files: Object.keys(files) });
  }
  return out;
}

// --- Structural JSON-schema validator (R8 fallback — ajv absent) -------------
// Covers exactly what the pinned schemas assert for these few manifests: required
// keys, types, name patterns, semver, and the remote/transport/OAuth shape of
// server.json. Deterministic, offline, dependency-free.

function loadSchema(file) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, file), 'utf8'));
}

const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Validate a plugin.json object against plugin.schema.json. → problems[] */
function validatePlugin(obj) {
  const p = [];
  if (typeof obj !== 'object' || obj === null) return ['not a JSON object'];
  if (typeof obj.name !== 'string') p.push('name: required string');
  else if (!/^[a-z0-9-]+$/.test(obj.name)) p.push(`name "${obj.name}": must match ^[a-z0-9-]+$`);
  if (typeof obj.version !== 'string') p.push('version: required string');
  else if (!SEMVER_RE.test(obj.version)) p.push(`version "${obj.version}": not semver`);
  if ('description' in obj && typeof obj.description !== 'string') p.push('description: must be string');
  if ('author' in obj) {
    if (typeof obj.author !== 'object' || obj.author === null || typeof obj.author.name !== 'string')
      p.push('author: must be an object with a string name');
  }
  return p;
}

/** Validate a marketplace.json object against marketplace.schema.json. → problems[] */
function validateMarketplace(obj) {
  const p = [];
  if (typeof obj !== 'object' || obj === null) return ['not a JSON object'];
  if (typeof obj.name !== 'string' || !/^[a-z0-9-]+$/.test(obj.name)) p.push('name: required, ^[a-z0-9-]+$');
  if (typeof obj.owner !== 'object' || obj.owner === null || typeof obj.owner.name !== 'string')
    p.push('owner: required object with string name');
  if (!Array.isArray(obj.plugins) || obj.plugins.length < 1) p.push('plugins: required non-empty array');
  else
    obj.plugins.forEach((pl, i) => {
      if (typeof pl !== 'object' || pl === null) { p.push(`plugins[${i}]: not an object`); return; }
      if (typeof pl.name !== 'string' || !/^[a-z0-9-]+$/.test(pl.name)) p.push(`plugins[${i}].name: required, ^[a-z0-9-]+$`);
      if (typeof pl.source !== 'string' || !pl.source) p.push(`plugins[${i}].source: required string`);
    });
  return p;
}

/** Validate the plugin's .mcp.json (no upstream schema — structural checks live here). → problems[] */
function validateMcp(obj) {
  const p = [];
  if (typeof obj !== 'object' || obj === null) return ['not a JSON object'];
  const s = obj.mcpServers && obj.mcpServers.squire;
  if (!s || typeof s !== 'object') { p.push('mcpServers.squire: required object (server key MUST be "squire", FR-004)'); return p; }
  if (s.type !== 'http') p.push(`mcpServers.squire.type "${s.type}": must be "http"`);
  if (typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) p.push('mcpServers.squire.url: required http(s) URL');
  return p;
}

/** Validate server.json against the pinned registry schema (structural). → problems[] */
function validateRegistry(obj) {
  const p = [];
  if (typeof obj !== 'object' || obj === null) return ['not a JSON object'];
  if (typeof obj.name !== 'string' || !/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(obj.name))
    p.push('name: required reverse-DNS "namespace/name"');
  if (typeof obj.description !== 'string' || obj.description.length < 1 || obj.description.length > 100)
    p.push('description: required string, 1..100 chars');
  if (typeof obj.version !== 'string') p.push('version: required string');
  if ('packages' in obj) p.push('packages: MUST be absent (remote-only server, no package/stdio artifact — RBD-7)');
  if (!Array.isArray(obj.remotes) || obj.remotes.length < 1) p.push('remotes: required non-empty array');
  else
    obj.remotes.forEach((r, i) => {
      if (typeof r !== 'object' || r === null) { p.push(`remotes[${i}]: not an object`); return; }
      if (r.type !== 'streamable-http') p.push(`remotes[${i}].type "${r.type}": must be "streamable-http"`);
      if (typeof r.url !== 'string' || !/^https:\/\//.test(r.url)) p.push(`remotes[${i}].url: required https URL`);
      if (r.type === 'stdio') p.push(`remotes[${i}]: stdio transport not allowed (remote-only)`);
    });
  // OAuth posture must be declared (RBD-7) under the publisher-provided extension.
  const pub = obj._meta && obj._meta['io.modelcontextprotocol.registry/publisher-provided'];
  if (!pub || pub.authentication !== 'oauth2')
    p.push('_meta publisher-provided authentication: expected "oauth2" (OAuth declaration, RBD-7)');
  return p;
}

/**
 * Validate the whole Kiro Power file map (FR-022): POWER.md frontmatter + ordered
 * body + License-and-Support triad, and mcp.json shape (type:"http", https url, no
 * oauth). Takes the FULL { rel: content } map (POWER.md is not JSON). → problems[]
 */
function validateKiroPower(files) {
  const p = [];
  const power = files['POWER.md'];
  if (typeof power !== 'string') {
    p.push('POWER.md: missing');
  } else {
    const fmMatch = power.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fmMatch) {
      p.push('POWER.md: missing YAML frontmatter');
    } else {
      const fm = fmMatch[1];
      const strField = (k) => {
        const m = fm.match(new RegExp(`^${k}:\\s*"?([^"\\n]+?)"?\\s*$`, 'm'));
        return m ? m[1].trim() : null;
      };
      for (const k of ['name', 'displayName', 'description', 'author']) {
        if (!strField(k)) p.push(`POWER.md frontmatter: ${k} required`);
      }
      const kwLine = fm.match(/^keywords:\s*(\[.*\])\s*$/m);
      if (!kwLine) {
        p.push('POWER.md frontmatter: keywords required (JSON array)');
      } else {
        try {
          const arr = JSON.parse(kwLine[1]);
          if (!Array.isArray(arr) || arr.length < 1) p.push('POWER.md frontmatter: keywords must be a non-empty array');
        } catch { p.push('POWER.md frontmatter: keywords is not a valid array'); }
      }
      const ver = strField('version');
      if (!ver) p.push('POWER.md frontmatter: version required (the version carrier, RBD-2)');
      else if (!SEMVER_RE.test(ver)) p.push(`POWER.md frontmatter: version "${ver}" not semver`);
      const name = strField('name');
      if (name && !/^[a-z0-9-]+$/.test(name)) p.push(`POWER.md frontmatter: name "${name}" must be kebab-case`);
    }
    const body = power.replace(/^---\n[\s\S]*?\n---\n/, '');
    const sections = [
      'Overview', 'When to Use This Power', 'Onboarding', 'Available Steering Files',
      'When to Load Steering Files', 'Available MCP Servers', 'MCP Configuration', 'License and Support',
    ];
    const positions = sections.map((s) => body.indexOf(`## ${s}`));
    positions.forEach((pos, i) => { if (pos < 0) p.push(`POWER.md body: missing section "## ${sections[i]}"`); });
    let last = -1;
    for (const pos of positions) {
      if (pos < 0) continue;
      if (pos < last) { p.push('POWER.md body: sections are out of the required order'); break; }
      last = pos;
    }
    const lsIdx = body.indexOf('## License and Support');
    if (lsIdx >= 0) {
      const ls = body.slice(lsIdx);
      if (!/\bMIT\b/.test(ls)) p.push('POWER.md License and Support: missing MIT license id');
      if (!ls.includes('https://squiredocs.com/privacy')) p.push('POWER.md License and Support: missing privacy policy link');
      if (!ls.includes('hello@squiredocs.com')) p.push('POWER.md License and Support: missing support contact');
    }
  }
  const mcpRaw = files['mcp.json'];
  if (typeof mcpRaw !== 'string') {
    p.push('mcp.json: missing');
  } else {
    let obj = null;
    try { obj = JSON.parse(mcpRaw); } catch (e) { p.push(`mcp.json: invalid JSON (${e.message})`); }
    if (obj) {
      const s = obj.mcpServers && obj.mcpServers['squire-docs'];
      if (!s || typeof s !== 'object') {
        p.push('mcp.json: mcpServers["squire-docs"] required object (server key MUST be "squire-docs", RBD-1)');
      } else {
        if (s.type !== 'http') p.push(`mcp.json: mcpServers["squire-docs"].type "${s.type}": must be "http"`);
        if (typeof s.url !== 'string' || !/^https:\/\//.test(s.url)) p.push('mcp.json: url required https URL');
        if ('oauth' in s || 'oauthScopes' in s) p.push('mcp.json: must NOT contain oauth/oauthScopes (DCR self-registers, FR-004)');
      }
    }
  }
  return p;
}

// Cursor kebab name pattern — verbatim from the vendored schema (FR-010/023).
const CURSOR_NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Validate .cursor-plugin/plugin.json against the vendored Cursor schema (FR-010/023):
 * required kebab `name`, semver `version`, author {name(+optional email)}, string
 * license, string homepage/repository when present, and — the additionalProperties:false
 * intent — reject any top-level key not in the vendored schema's `properties`. The
 * allowed key set is DERIVED from the vendored file, so it tracks a schema refresh.
 * → problems[]
 */
function validateCursorPlugin(obj) {
  const p = [];
  if (typeof obj !== 'object' || obj === null) return ['not a JSON object'];
  // Allowed top-level keys come from the vendored schema (additionalProperties:false).
  let allowed = null;
  try {
    const schema = loadSchema('cursor-plugin.schema.json');
    allowed = new Set(Object.keys(schema.properties || {}));
  } catch {
    p.push('vendored cursor-plugin.schema.json not readable — cannot derive allowed keys');
  }
  if (allowed) {
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) p.push(`unexpected key "${k}": not in the vendored schema (additionalProperties:false)`);
    }
  }
  if (typeof obj.name !== 'string') p.push('name: required string');
  else if (!CURSOR_NAME_RE.test(obj.name)) p.push(`name "${obj.name}": must match ${CURSOR_NAME_RE}`);
  if ('version' in obj) {
    if (typeof obj.version !== 'string' || !SEMVER_RE.test(obj.version)) p.push(`version "${obj.version}": not semver`);
  }
  if ('description' in obj && typeof obj.description !== 'string') p.push('description: must be string');
  if ('displayName' in obj && typeof obj.displayName !== 'string') p.push('displayName: must be string');
  if ('author' in obj) {
    const a = obj.author;
    if (typeof a !== 'object' || a === null || typeof a.name !== 'string') p.push('author: must be an object with a string name');
    else if ('email' in a && typeof a.email !== 'string') p.push('author.email: must be string');
  }
  if ('license' in obj && typeof obj.license !== 'string') p.push('license: must be a string SPDX id');
  for (const k of ['homepage', 'repository']) {
    if (k in obj && typeof obj[k] !== 'string') p.push(`${k}: must be a string URL`);
  }
  if ('keywords' in obj && !Array.isArray(obj.keywords)) p.push('keywords: must be an array');
  if ('category' in obj && typeof obj.category !== 'string') p.push('category: must be a string');
  return p;
}

/**
 * Validate the Cursor mcp.json (FR-011): mcpServers["squire-docs"] present with a
 * bare https `url` and NO `type` field (the Cursor-correct remote shape — the
 * absence of `type` is asserted here, and ONLY here). → problems[]
 */
function validateCursorMcp(obj) {
  const p = [];
  if (typeof obj !== 'object' || obj === null) return ['not a JSON object'];
  const s = obj.mcpServers && obj.mcpServers['squire-docs'];
  if (!s || typeof s !== 'object') { p.push('mcpServers["squire-docs"]: required object (server key MUST be "squire-docs", RBD-1)'); return p; }
  if (typeof s.url !== 'string' || !/^https:\/\//.test(s.url)) p.push('mcpServers["squire-docs"].url: required https URL');
  if ('type' in s) p.push('mcpServers["squire-docs"]: must NOT contain a "type" field (Cursor bare-url convention, FR-011)');
  if ('auth' in s) p.push('mcpServers["squire-docs"]: must NOT contain an "auth" block (DCR, FR-011)');
  return p;
}

/**
 * Validate an Agent-Requested .mdc rule (FR-012/023): frontmatter `description`
 * non-empty and `alwaysApply: false`. Takes the RAW file content. → problems[]
 */
function validateMdcRule(content) {
  const p = [];
  if (typeof content !== 'string') return ['not a string'];
  const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) { p.push('missing YAML frontmatter'); return p; }
  const desc = fm[1].match(/^description:\s*(.+?)\s*$/m);
  if (!desc || !desc[1].trim()) p.push('frontmatter description: required non-empty (Agent-Requested rule)');
  const always = fm[1].match(/^alwaysApply:\s*(\S+)\s*$/m);
  if (!always) p.push('frontmatter alwaysApply: required');
  else if (always[1].trim() !== 'false') p.push(`frontmatter alwaysApply: must be false (Agent-Requested), got "${always[1].trim()}"`);
  return p;
}

const VALIDATORS = {
  plugin: validatePlugin,
  marketplace: validateMarketplace,
  mcp: validateMcp,
  registry: validateRegistry,
  'kiro-power': validateKiroPower,
  'cursor-plugin': validateCursorPlugin,
  'cursor-mcp': validateCursorMcp,
  'mdc-rule': validateMdcRule,
};

// Validator dispatch kinds: JSON manifests are JSON.parse'd then validated; a
// FILES kind receives the whole { rel: content } map; a RAW kind receives the raw
// string content of its manifestRel (e.g. the .mdc rule, which is not JSON).
const FILES_KINDS = new Set(['kiro-power']);
const RAW_KINDS = new Set(['mdc-rule']);

/**
 * Validate every generated manifest against its pinned schema (FR-009/010/011).
 * Offline, deterministic. Advisory plugin-dev validator attempted where available;
 * its absence is a reported warning, never a failure.
 * @returns {{ ok: boolean, problems: string[], warnings: string[] }}
 */
export function validateBundles() {
  const problems = [];
  const warnings = [];
  for (const ch of CHANNELS) {
    const files = ch.files({ endpoint: PROD_ENDPOINT });
    for (const binding of ch.schemas) {
      const raw = files[binding.manifestRel];
      if (raw == null) { problems.push(`${ch.id}/${binding.manifestRel}: generated file missing`); continue; }
      // Confirm the pinned schema file is present (so a deleted schema is caught).
      if (binding.file) {
        try { loadSchema(binding.file); }
        catch { problems.push(`${ch.id}/${binding.manifestRel}: pinned schema ${binding.file} not readable`); continue; }
      }
      const fn = VALIDATORS[binding.kind];
      if (!fn) { problems.push(`${ch.id}/${binding.manifestRel}: no validator for kind "${binding.kind}"`); continue; }
      if (FILES_KINDS.has(binding.kind)) {
        // Whole-bundle validator (e.g. Kiro POWER.md + mcp.json) — pass the file map.
        for (const prob of fn(files)) problems.push(`${ch.id}: ${prob}`);
      } else if (RAW_KINDS.has(binding.kind)) {
        // Non-JSON text manifest (e.g. the .mdc rule) — pass the raw content.
        for (const prob of fn(raw)) problems.push(`${ch.id}/${binding.manifestRel}: ${prob}`);
      } else {
        let obj;
        try { obj = JSON.parse(raw); }
        catch (e) { problems.push(`${ch.id}/${binding.manifestRel}: invalid JSON (${e.message})`); continue; }
        for (const prob of fn(obj)) problems.push(`${ch.id}/${binding.manifestRel}: ${prob}`);
      }
    }
  }
  // Advisory plugin-dev validator (FR-011) — attempted, never fatal.
  const probe = spawnSync('claude', ['plugin', '--help'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    warnings.push('advisory plugin-dev validator not available (claude plugin CLI absent) — schema gate is authoritative (FR-011)');
  }
  return { ok: problems.length === 0, problems, warnings };
}

// --- Publish path (Sam op) — MUST fail closed (RBD-6, FR-012/013, INV-1) ------
// Never exercised against a real remote by tests/CI; push-mechanism tests use
// local bare-repo fixtures only. A default (no --publish) run never reaches here.

// Identity stamped on every generated mirror commit — set explicitly so the
// public commits never fall back to the ambient user (e.g. `root@<pod-host>`).
const PUBLISH_IDENTITY = { name: 'Sam', email: 'sam@squiredocs.com' };

function gitOut(args, opts = {}) {
  const res = spawnSync('git', args, { encoding: 'utf8', ...opts });
  return { status: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim(), error: res.error };
}

/** This repo's HEAD commit, for the generated push message (best-effort). */
function sourceCommit() {
  const r = gitOut(['rev-parse', 'HEAD'], { cwd: REPO_ROOT });
  return r.status === 0 ? r.stdout : 'unknown';
}

/**
 * Resolve the configured mirror remote for a channel from the environment.
 * Returns null when unset — NEVER a committed default (INV-1: a default that
 * could resolve for a pipeline agent is a HIGH finding).
 */
export function mirrorRemoteFor(channel, env = process.env) {
  const v = env[channel.mirrorEnv];
  return v && v.trim() ? v.trim() : null;
}

/**
 * Recursively compare the freshly-generated files for a channel against a checked-out
 * mirror working tree. Returns { changed, versionRel, mirrorVersion, freshVersion }.
 *
 * The version is read through the channel's DECLARED carrier (FR-017) — the SAME
 * `channel.readVersion` applied to the fresh in-memory map AND the mirror-on-disk
 * map, so no channel gets a weaker (or a wrong-file) version read. This replaces the
 * former hardcoded `id === 'mcp-registry' ? 'server.json' : '.claude-plugin/...'`
 * branch, which could not express Kiro's POWER.md-frontmatter carrier at all.
 * SECURITY (constitution V): the guard's three refusals — content-change-without-bump,
 * non-forward bump, present-but-unreadable — MUST fire identically for every channel.
 */
// Files a fresh clone can carry WITHOUT being a prior publish: GitHub's "initialize
// with…" seeds. Their presence alone must NOT count as a populated mirror, or a
// genuine first publish into a README-seeded repo would be refused (033 review MEDIUM).
const MIRROR_SEED_FILES = new Set(['README.md', 'LICENSE', '.gitignore']);

/** Recursively list a mirror clone's files as posix rel paths, skipping .git. */
function listMirrorFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (rel === '' && e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

function diffAgainstMirror(channel, mirrorDir) {
  // The publish path is ALWAYS prod-pinned — a dev endpoint can never be staged
  // for a mirror (032 review HIGH #2). There is no endpoint parameter here.
  const fresh = channel.files({ endpoint: PROD_ENDPOINT });
  const freshRels = new Set(Object.keys(fresh));
  const mirrorRels = listMirrorFiles(mirrorDir);
  let changed = false;
  for (const [rel, content] of Object.entries(fresh)) {
    const onDisk = path.join(mirrorDir, rel);
    if (!fs.existsSync(onDisk) || fs.readFileSync(onDisk, 'utf8') !== content) { changed = true; break; }
  }
  // A file the generator no longer emits, still live on the mirror, is a change too
  // (033 review LOW): without this a deletion-only regeneration reports "no change",
  // skips the version guard, and the retired file lingers on the public mirror. Any
  // real bump touches the carrier and prune-before-stage would remove it — but a
  // deletion with no other byte change and no bump would otherwise slip the guard.
  if (!changed) {
    for (const rel of mirrorRels) { if (!freshRels.has(rel)) { changed = true; break; } }
  }
  // Read the version via the channel's declared carrier, on BOTH sides.
  const versionRel = channel.versionCarrierRel;
  const freshVersion = channel.readVersion(fresh);
  // Distinguish "no mirror carrier" (genuine first publish, ok) from "carrier
  // present but unreadable" (refuse — never silently treat as first publish, 032
  // review LOW #5). A carrier that reads but yields null/throws is UNREADABLE, so
  // a Kiro bundle whose POWER.md lost its `version:` frontmatter can never be
  // republished unguarded (the FR-017 hole this refactor must not open).
  let mirrorVersion = null;
  let mirrorVersionUnreadable = false;
  const carrierPath = path.join(mirrorDir, versionRel);
  if (fs.existsSync(carrierPath)) {
    // Build a {rel:content} map with the carrier file so channel.readVersion —
    // the identical function used on the fresh side — reads the mirror version.
    const mirrorMap = { [versionRel]: fs.readFileSync(carrierPath, 'utf8') };
    try { mirrorVersion = channel.readVersion(mirrorMap); }
    catch { mirrorVersionUnreadable = true; }
    if (mirrorVersion == null) mirrorVersionUnreadable = true;
  } else if (mirrorRels.some((rel) => freshRels.has(rel) && rel !== versionRel && !MIRROR_SEED_FILES.has(rel))) {
    // The carrier file is GONE but the mirror still holds a generator-emitted,
    // non-seed file — a populated mirror missing its version carrier (a botched
    // partial push, or POWER.md deleted/renamed mirror-side), NOT a fresh repo.
    // Refuse rather than treat as first-publish, which would republish unguarded
    // (033 review MEDIUM — the carrier-absent counterpart to the unreadable guard).
    mirrorVersionUnreadable = true;
  }
  return { changed, versionRel, mirrorVersion, freshVersion, mirrorVersionUnreadable };
}

/** Parse "a.b.c" → [a,b,c] ints; non-semver → null. */
function semver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [+m[1], +m[2], +m[3]] : null;
}
/** Returns true iff a is strictly greater than b (both semver-parseable). */
function semverGt(a, b) {
  const pa = semver(a); const pb = semver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] > pb[i]; }
  return false;
}

/**
 * Push every configured mirror. Fail-closed: with no configured remotes (or an
 * unreachable one) it refuses BEFORE any write, zero side effects.
 * The version-bump guard (FR-013): if regenerated content differs from the mirror
 * while the manifest version is unchanged → refuse, no push.
 *
 * The publish path is ALWAYS prod-pinned — there is deliberately NO endpoint
 * parameter, so no dev/localhost endpoint can ever be staged for a real mirror
 * (032 review HIGH #2). Tests point the mirror env vars at LOCAL bare repos only.
 *
 * @param {{ env?: object, cloneRoot?: string }} [opts]
 * @returns {{ ok: boolean, problems: string[], pushed: string[] }}
 */
export function publishMirrors({ env = process.env, cloneRoot = null } = {}) {
  const problems = [];
  const pushed = [];

  // Precondition 1: at least one mirror remote configured (fail closed).
  const configured = CHANNELS.map((ch) => ({ ch, remote: mirrorRemoteFor(ch, env) })).filter((x) => x.remote);
  if (configured.length === 0) {
    return {
      ok: false,
      pushed,
      problems: [
        'no mirror remotes configured — refusing to publish (fail-closed, RBD-6/INV-1). '
        + `Set ${CHANNELS.map((c) => c.mirrorEnv).join(' and/or ')} to real remotes, then re-run with --publish.`,
      ],
    };
  }

  // Precondition 2: bundles must be schema-valid before any push.
  const val = validateBundles();
  if (!val.ok) {
    return { ok: false, pushed, problems: ['refusing to publish — bundles do not validate:', ...val.problems] };
  }

  const workRoot = cloneRoot || fs.mkdtempSync(path.join(REPO_ROOT, '.publish-mirror-'));
  const commit = sourceCommit();
  try {
    for (const { ch, remote } of configured) {
      const mirrorDir = path.join(workRoot, ch.id);
      // Clone/fetch the mirror. Unreachable remote → fail closed, no side effects yet.
      const clone = gitOut(['clone', '--depth', '1', remote, mirrorDir]);
      if (clone.status !== 0) {
        problems.push(`${ch.id}: mirror clone failed (${remote}): ${clone.stderr || clone.error?.message || 'unknown'}`);
        continue;
      }
      // Version-bump guard (FR-013) + downgrade/unreadable guards (032 review LOW #5).
      const { changed, versionRel, mirrorVersion, freshVersion, mirrorVersionUnreadable } = diffAgainstMirror(ch, mirrorDir);
      if (!changed) { pushed.push(`${ch.id}: no change (skipped)`); continue; }
      if (mirrorVersionUnreadable) {
        problems.push(`${ch.id}: mirror ${versionRel} is present but unreadable — refusing (cannot verify the version guard).`);
        continue;
      }
      if (mirrorVersion != null && mirrorVersion === freshVersion) {
        problems.push(
          `${ch.id}: content changed but ${versionRel} version is unchanged (${freshVersion}). `
          + 'Bump the version before publishing (FR-013) — refusing, no push.',
        );
        continue;
      }
      if (mirrorVersion != null && !semverGt(freshVersion, mirrorVersion)) {
        problems.push(
          `${ch.id}: refusing to publish ${freshVersion} over mirror ${mirrorVersion} — not a forward version bump.`,
        );
        continue;
      }
      // Prune the mirror working tree (keep .git) before staging, so a file the
      // generator no longer emits does not linger live in the public mirror (032
      // review MEDIUM #4). git add -A then records the deletions.
      for (const entry of fs.readdirSync(mirrorDir)) {
        if (entry === '.git') continue;
        fs.rmSync(path.join(mirrorDir, entry), { recursive: true, force: true });
      }
      // Stage the regenerated (PROD-pinned) files into the mirror clone and push.
      for (const [rel, content] of Object.entries(ch.files({ endpoint: PROD_ENDPOINT }))) {
        const dest = path.join(mirrorDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
      }
      const add = gitOut(['add', '-A'], { cwd: mirrorDir });
      if (add.status !== 0) { problems.push(`${ch.id}: git add failed: ${add.stderr}`); continue; }
      const msg = `Publish ${ch.id} from squire source ${commit}`;
      const cm = gitOut(
        ['-c', `user.name=${PUBLISH_IDENTITY.name}`, '-c', `user.email=${PUBLISH_IDENTITY.email}`, 'commit', '-m', msg],
        { cwd: mirrorDir },
      );
      if (cm.status !== 0) { problems.push(`${ch.id}: git commit failed: ${cm.stderr}`); continue; }
      const push = gitOut(['push', 'origin', 'HEAD'], { cwd: mirrorDir });
      if (push.status !== 0) { problems.push(`${ch.id}: git push failed: ${push.stderr}`); continue; }
      pushed.push(`${ch.id}: pushed (${msg})`);
    }
  } finally {
    if (!cloneRoot) { try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  return { ok: problems.length === 0, problems, pushed };
}

// --- CLI ---------------------------------------------------------------------

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

function runCli(argv) {
  const doPublish = argv.includes('--publish');
  const outRoot = arg(argv, '--out', null);
  const endpoint = arg(argv, '--endpoint', PROD_ENDPOINT);

  // Publishing is prod-only and mutually exclusive with dev materialization: a
  // non-prod --endpoint or an --out target can never be combined with --publish
  // (032 review HIGH #2). Checked FIRST so any publish+dev combination is refused
  // with this message. The push path itself ignores `endpoint` entirely; this is
  // the belt-and-suspenders CLI guard.
  if (doPublish && (outRoot || endpoint !== PROD_ENDPOINT)) {
    console.error('✗ --publish cannot be combined with --out or a non-prod --endpoint. Publishing always ships the prod-pinned bundle.');
    process.exit(2);
  }
  if (endpoint !== PROD_ENDPOINT && !outRoot) {
    console.error('✗ --endpoint may only be used with --out (local materialization); the committed bundle is prod-pinned.');
    process.exit(2);
  }

  // 1. Regenerate.
  const written = generateAll({ endpoint, outRoot: outRoot ? path.resolve(outRoot) : null });
  console.log(`Regenerated ${written.length} channel(s)${outRoot ? ` → ${path.resolve(outRoot)}` : ' (committed tree)'}:`);
  for (const w of written) console.log(`  • ${w.id}: ${w.files.length} file(s)`);

  // 2. Validate.
  const val = validateBundles();
  for (const w of val.warnings) console.log(`  ! ${w}`);
  if (!val.ok) {
    console.error('\n✗ validation failed:');
    for (const p of val.problems) console.error(`  - ${p}`);
    console.error('\nFix the derivation in distribution/publish.mjs, then re-run: node distribution/publish.mjs');
    process.exit(1);
  }
  console.log('✓ all bundles validate against the pinned schemas.');

  // 3. Publish only when explicitly asked — dry-run is the default (RBD-6, INV-1).
  if (!doPublish) {
    console.log('\n(dry-run: no push. Pushing is a Sam op — see the usage header for the --publish invocation.)');
    process.exit(0);
  }
  console.log('\n--publish: attempting configured mirrors (fail-closed if none)...');
  const res = publishMirrors();
  for (const line of res.pushed) console.log(`  • ${line}`);
  if (!res.ok) {
    console.error('\n✗ publish refused / incomplete:');
    for (const p of res.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('✓ mirrors published.');
  process.exit(0);
}

// Robust CLI-entry check (handles spaces/symlinks in the path — 032 review LOW #8).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
