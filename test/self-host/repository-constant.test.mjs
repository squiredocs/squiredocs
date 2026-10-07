/**
 * The repository name is one constant, REPOSITORY in
 * distribution/self-host/release.mjs, mirrored as a literal in four files that
 * are served or published verbatim (feature 060, T011, RBD-060-20). Every
 * github.com/<x>/<y> and ghcr.io/<x>/<y> reference in them must equal it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPOSITORY } from '../../distribution/self-host/release.mjs';
import { ROOT } from './helpers.mjs';

const FILES = [
  'AGENTS.md',
  'distribution/self-host/install.sh',
  'distribution/self-host/compose.yml',
  'documentation/self-hosting.md',
];

// owner/name after github.com/ or ghcr.io/. The name stops at a slash, colon,
// whitespace, quote, bracket, or a markdown/shell delimiter.
const REF_RE = /\b(github\.com|ghcr\.io)\/([^/\s"'`()[\]:#]+)\/([^/\s"'`()[\]:#]+)/g;

export function findRepositoryRefs(text) {
  const refs = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(REF_RE)) {
      // Shell variable references (install.sh builds URLs from $REPOSITORY).
      if (m[2].startsWith('$')) continue;
      refs.push({ line: i + 1, host: m[1], value: `${m[2]}/${m[3]}`.replace(/\.git$/, '') });
    }
  });
  return refs;
}

for (const rel of FILES) {
  test(`${rel} names only REPOSITORY`, () => {
    const full = path.join(ROOT, rel);
    assert.ok(fs.existsSync(full), `${rel} is missing (it must carry REPOSITORY ${REPOSITORY})`);
    const text = fs.readFileSync(full, 'utf8');
    const refs = findRepositoryRefs(text);
    const bad = refs.filter((r) => r.value !== REPOSITORY);
    assert.deepEqual(
      bad.map((r) => `${rel}:${r.line} ${r.host}/${r.value}`),
      [],
      `every reference must be ${REPOSITORY}`,
    );
    const assignment = /^REPOSITORY='([^']*)'$/m.exec(text);
    if (rel.endsWith('install.sh')) {
      assert.ok(assignment, `${rel} assigns REPOSITORY='...'`);
      assert.equal(assignment[1], REPOSITORY, `${rel} REPOSITORY assignment`);
    } else {
      assert.ok(refs.length > 0, `${rel} names the repository at least once`);
    }
  });
}

test('the reference finder sees placeholders and real names, and skips shell variables', () => {
  const refs = findRepositoryRefs([
    'image: ghcr.io/<org>/<repo>:1.0',
    'see https://github.com/acme/squire-docs/releases and https://github.com/acme/squire-docs.git',
    'url="https://github.com/${REPOSITORY}/releases"',
  ].join('\n'));
  assert.deepEqual(refs.map((r) => `${r.line}:${r.value}`), ['1:<org>/<repo>', '2:acme/squire-docs', '2:acme/squire-docs']);
});
