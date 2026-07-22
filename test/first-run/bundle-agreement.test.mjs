/**
 * Feature 030 US2 (FR-021, SC-004) — deterministic bundle drift test.
 *
 * The committed rehearsal bundle under test/first-run/assembled-bundle/ must agree
 * with distribution/shared/ (endpoint field exempt), and tampering with a generated
 * file must be detected. Runs with no model access.
 *
 *   node --test test/first-run/bundle-agreement.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBundleAgreement, checkContentBudgets, BUDGETS } from './check-bundle-agreement.mjs';
import { assembleBundle, DEFAULT_BUNDLE_DIR } from './assemble-bundle.mjs';

test('committed bundle agrees with distribution/shared/', () => {
  const { ok, problems } = checkBundleAgreement({ bundleDir: DEFAULT_BUNDLE_DIR });
  assert.equal(ok, true, `bundle drift: ${problems.join('; ')} (run: node test/first-run/assemble-bundle.mjs)`);
});

test('shared content is within the context budgets (RBD-13)', () => {
  const problems = checkContentBudgets();
  assert.deepEqual(problems, [], `budget overrun: ${problems.join('; ')}`);
  assert.ok(BUDGETS.skillDescriptionChars === 250, 'skill description budget is the /skills UI cap');
});

test('a hand-edited generated file is detected as drift', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-bundle-drift-'));
  try {
    assembleBundle({ outDir: tmp });
    const skill = path.join(tmp, 'skills', 'squire', 'SKILL.md');
    fs.appendFileSync(skill, '\nHAND EDIT\n');
    const { ok, problems } = checkBundleAgreement({ bundleDir: tmp });
    assert.equal(ok, false, 'drift must be detected');
    assert.ok(problems.some((p) => p.includes('SKILL.md')), 'the drifted file must be named');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an endpoint-only change to .mcp.json is NOT flagged (exempt field)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-bundle-ep-'));
  try {
    assembleBundle({ outDir: tmp });
    const mcp = path.join(tmp, '.mcp.json');
    const j = JSON.parse(fs.readFileSync(mcp, 'utf8'));
    j.mcpServers.squire.url = 'http://localhost:3052/mcp';
    fs.writeFileSync(mcp, JSON.stringify(j, null, 2) + '\n');
    const { ok } = checkBundleAgreement({ bundleDir: tmp });
    assert.equal(ok, true, 'endpoint field must be exempt from the agreement check');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
