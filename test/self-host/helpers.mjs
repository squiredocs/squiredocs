/**
 * Shared helpers for the Docker-free self-host suite (feature 060). Not a test
 * file (node --test runs only *.test.mjs).
 *
 * The production files carry REPOSITORY (squiredocs/squiredocs, RBD-060-1).
 * Tests run a temp copy of the production files, byte-identical by default;
 * placeholderCopy() swaps only that literal back to '<org>/<repo>' to prove
 * install.sh and release.mjs still refuse an unnamed repository.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SELF_HOST_DIR = path.join(ROOT, 'distribution/self-host');
export const STUB_BIN = path.join(ROOT, 'test/self-host/fixtures/stub-bin');
export const PLACEHOLDER = '<org>/<repo>';
// The production value (RBD-060-1, ratified 2026-10-07); release.mjs is the source.
export const TEST_REPOSITORY = /export const REPOSITORY = '([^']+)'/.exec(
  fs.readFileSync(path.join(SELF_HOST_DIR, 'release.mjs'), 'utf8'),
)[1];

export function tempDir(prefix = 'squire-060-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Copy the self-host sources into a temp dir with the production REPOSITORY
 * literal replaced by `repository` (unchanged by default). placeholderCopy()
 * puts the pre-decision placeholder back, to test the refusals.
 */
export function releasedCopy(repository = TEST_REPOSITORY) {
  const dir = tempDir('squire-060-src-');
  for (const name of ['release.mjs', 'compose.yml', 'squire', '.env.example', 'install.sh']) {
    const src = path.join(SELF_HOST_DIR, name);
    if (!fs.existsSync(src)) continue;
    const text = fs.readFileSync(src, 'utf8').split(TEST_REPOSITORY).join(repository);
    fs.writeFileSync(path.join(dir, name), text);
    fs.chmodSync(path.join(dir, name), fs.statSync(src).mode & 0o777);
  }
  return dir;
}

export function placeholderCopy() {
  return releasedCopy(PLACEHOLDER);
}

/** Locate a real binary on the standard system PATH, or null. */
export function which(name) {
  for (const d of ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}
