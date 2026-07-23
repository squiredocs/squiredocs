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
];

/**
 * Write every wave-1 channel's files into its committed outDir (or a mirror of
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

const VALIDATORS = { plugin: validatePlugin, marketplace: validateMarketplace, mcp: validateMcp, registry: validateRegistry };

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
      let obj;
      try { obj = JSON.parse(raw); }
      catch (e) { problems.push(`${ch.id}/${binding.manifestRel}: invalid JSON (${e.message})`); continue; }
      // Confirm the pinned schema file is present (so a deleted schema is caught).
      if (binding.file) {
        try { loadSchema(binding.file); }
        catch { problems.push(`${ch.id}/${binding.manifestRel}: pinned schema ${binding.file} not readable`); continue; }
      }
      const fn = VALIDATORS[binding.kind];
      if (!fn) { problems.push(`${ch.id}/${binding.manifestRel}: no validator for kind "${binding.kind}"`); continue; }
      for (const prob of fn(obj)) problems.push(`${ch.id}/${binding.manifestRel}: ${prob}`);
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
function diffAgainstMirror(channel, mirrorDir) {
  // The publish path is ALWAYS prod-pinned — a dev endpoint can never be staged
  // for a mirror (032 review HIGH #2). There is no endpoint parameter here.
  const fresh = channel.files({ endpoint: PROD_ENDPOINT });
  let changed = false;
  for (const [rel, content] of Object.entries(fresh)) {
    const onDisk = path.join(mirrorDir, rel);
    if (!fs.existsSync(onDisk) || fs.readFileSync(onDisk, 'utf8') !== content) { changed = true; break; }
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
