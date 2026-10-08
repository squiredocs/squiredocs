/**
 * LICENSE, CONTRIBUTING.md, SECURITY.md (feature 060, T044, FR-038,
 * RBD-060-13, RBD-060-14).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('LICENSE is MIT with the RBD-060-13 holder and equals every generated bundle LICENSE', () => {
  const license = read('LICENSE');
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 21st Harmonic LLC\n/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
  for (const bundle of ['claude-plugin', 'mcp-registry', 'cursor-plugin']) {
    assert.equal(read(`distribution/${bundle}/LICENSE`), license, `${bundle} LICENSE`);
  }
  assert.equal(JSON.parse(read('package.json')).license, 'MIT');
});

test('SECURITY.md: reporting channel, private disclosure, supported versions, security page', () => {
  const s = read('SECURITY.md');
  assert.match(s, /security@squiredocs\.com/);
  assert.match(s, /private disclosure/i);
  assert.match(s, /latest Squire Docs release/);
  assert.match(s, /hosted service/);
  assert.match(s, /https:\/\/squiredocs\.com\/security/);
});

test('CONTRIBUTING.md: setup, tests, license terms, no DCO or CLA, issues first, writing rules', () => {
  const c = read('CONTRIBUTING.md');
  assert.match(c, /docs\/dev\.md/);
  for (const cmd of ['npm test', 'npm run test:server', 'npm run test:client', 'npm run test:first-run', 'npm run test:self-host']) {
    assert.ok(c.includes(`\`${cmd}\``), cmd);
  }
  assert.match(c, /MIT license/);
  assert.match(c, /No DCO sign-off and no contributor license agreement/);
  assert.match(c, /issue[^.]*before a large\s+change/i);
  assert.match(c, /No em dashes/);
  assert.match(c, /"Squire Docs", never just "Squire"/);
});

test('the three files use no em dashes', () => {
  for (const f of ['CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md']) assert.ok(!read(f).includes('—'), f);
});
