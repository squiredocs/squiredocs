/**
 * AGENTS.md is the self-host runbook served as /self-host.md (feature 060,
 * T016, FR-022 to FR-024, D10, RBD-060-3, RBD-060-33).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { REPOSITORY } from '../../distribution/self-host/release.mjs';
import { ROOT } from './helpers.mjs';

const require = createRequire(import.meta.url);
const text = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
const lines = text.split('\n');

// Lines inside ``` fences: the commands an agent runs.
const commandLines = [];
{
  let inFence = false;
  for (const l of lines) {
    if (l.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) commandLines.push(l);
  }
}
// Inline code spans plus fenced lines: every command the file names.
const allCommands = [...commandLines, ...[...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])];

/** Index of the first occurrence of `needle`, asserting presence. */
function at(needle) {
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `AGENTS.md contains ${JSON.stringify(needle)}`);
  return i;
}

test('the first line is the RBD-060-3 preface', () => {
  assert.match(lines[0], /self-hosting runbook for agents/);
  assert.match(lines[0], /https:\/\/squiredocs\.com\/self-host\.md/);
  assert.match(lines[0], /CONTRIBUTING\.md/);
});

test('sections appear in the FR-023 order', () => {
  const R = `https://github.com/${REPOSITORY}/releases/latest/download`;
  const order = [
    'docker compose version',
    '2.24',
    'curl -fsSL https://squiredocs.com/install.sh | sh -s -- --name "<name>" --email "<email>"',
    'mkdir squire-docs && cd squire-docs',
    `curl -fsSLO ${R}/compose.yml`,
    `curl -fsSLO ${R}/squire && chmod +x squire`,
    'docker compose up -d --wait',
    'docker compose exec app squire claim-link',
    'bare, on its own line, with nothing appended',
    'claude mcp add --transport http squire-local http://localhost:3910/mcp',
    'Approve',
    'docker compose exec app squire token create --name',
    '## Recovery',
    'docker compose logs app',
    'SQUIRE_PORT',
    'docker compose pull && docker compose up -d --wait',
    'docker compose down -v',
    'Plain HTTP is supported only on localhost',
  ];
  // Each item must occur after the previous one (sequential search).
  let from = 0;
  for (let i = 0; i < order.length; i++) {
    const j = text.indexOf(order[i], from);
    assert.ok(j >= 0, `${JSON.stringify(order[i])} appears after ${JSON.stringify(order[i - 1] || 'the start')}`);
    from = j + order[i].length;
  }
});

test('each manual step and the install command state a success condition', () => {
  const steps = text.split(/^```sh$/m).slice(1);
  assert.ok(steps.length >= 9);
  for (const chunk of steps) {
    const [cmd, after] = chunk.split(/^```$/m);
    assert.match(after.split(/^```sh$/m)[0], /Success:/, `success condition after ${cmd.trim()}`);
  }
  assert.match(text, /last line of stdout is a claim link/);
});

test('recovery covers a new link, the startup-log link, the port, logs, and the two-step upgrade', () => {
  const recovery = text.slice(at('## Recovery'), at('## Stopping safely'));
  assert.match(recovery, /docker compose exec app squire claim-link/);
  assert.match(recovery, /startup-log link/i);
  assert.match(recovery, /docker compose logs app/);
  assert.match(recovery, /SQUIRE_PORT=/);
  assert.match(recovery, /Set `SQUIRE_VERSION` in `\.env` to the new release/);
  assert.match(recovery, /docker compose pull && docker compose up -d --wait/);
});

test('the down -v warning names the encryption key and the safe stop', () => {
  const stop = text.slice(at('## Stopping safely'));
  assert.match(stop, /`docker compose down` stops the instance and keeps every document/);
  assert.match(stop, /docker compose down -v/);
  assert.match(stop, /encryption key/);
  assert.match(stop, /every document/);
});

test('FR-040: plain HTTP only on localhost; exposing needs TLS and an https APP_URL', () => {
  assert.match(text, /Plain HTTP is supported only on localhost\. Exposing an instance to other\s+machines requires a TLS-terminating proxy in front of it and an https\s+`APP_URL`/);
});

test('commands use the full docker form, never ./squire (D10, RBD-060-33)', () => {
  for (const l of commandLines) {
    assert.ok(!l.includes('./squire'), `command line uses ./squire: ${l}`);
    if (/\bsquire (doctor|claim-link|login-link|mode|token)\b/.test(l)) {
      assert.match(l, /^docker compose exec app squire /, `full form: ${l}`);
    }
  }
});

test('every squire subcommand named exists in server/cli (FR-024)', () => {
  const { COMMANDS } = require(path.join(ROOT, 'server/cli/index.js'));
  const named = new Set();
  for (const c of allCommands) {
    for (const m of c.matchAll(/\bsquire (token create|[a-z][a-z-]*)/g)) named.add(m[1]);
  }
  assert.ok(named.has('doctor') && named.has('claim-link') && named.has('token create'), [...named].join(', '));
  for (const n of named) assert.ok(Object.hasOwn(COMMANDS, n), `squire ${n} exists in server/cli COMMANDS`);
});

test('every path it names is served: /ready, /mcp, /claim (FR-024)', () => {
  assert.match(text, /localhost:3910\/ready/);
  assert.match(text, /localhost:3910\/mcp/);
  assert.match(text, /\/claim#<token>/);
  const index = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.match(index, /app\.get\('\/ready'/);
  assert.match(index, /app\.use\('\/mcp'/);
  const appJsx = fs.readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
  assert.match(appJsx, /path === '\/claim'/);
});

test('prose says "Squire Docs", never bare "Squire"', () => {
  const prose = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/https?:\/\/\S+/g, '');
  const bare = [...prose.matchAll(/\bSquire\b(?! Docs)/g)].map((m) => prose.slice(m.index - 20, m.index + 20));
  assert.deepEqual(bare, []);
  assert.ok(!text.includes('—'), 'no em dashes');
});
