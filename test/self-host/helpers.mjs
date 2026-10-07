/**
 * Shared helpers for the Docker-free self-host suite (feature 060). Not a test
 * file (node --test runs only *.test.mjs).
 *
 * The production files carry the placeholder repository '<org>/<repo>' until
 * Sam names the repository (RBD-060-20), and both install.sh and release.mjs
 * refuse to run with it. Tests that need the released behavior run a temp
 * copy of the production files with only that literal replaced; nothing else
 * changes, so the code under test is the production code.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SELF_HOST_DIR = path.join(ROOT, 'distribution/self-host');
export const STUB_BIN = path.join(ROOT, 'test/self-host/fixtures/stub-bin');
export const PLACEHOLDER = '<org>/<repo>';
export const TEST_REPOSITORY = 'acme/squire-docs';

export function tempDir(prefix = 'squire-060-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copy the self-host sources into a temp dir with REPOSITORY replaced. */
export function releasedCopy(repository = TEST_REPOSITORY) {
  const dir = tempDir('squire-060-src-');
  for (const name of ['release.mjs', 'compose.yml', 'squire', '.env.example', 'install.sh']) {
    const src = path.join(SELF_HOST_DIR, name);
    if (!fs.existsSync(src)) continue;
    const text = fs.readFileSync(src, 'utf8').split(PLACEHOLDER).join(repository);
    fs.writeFileSync(path.join(dir, name), text);
    fs.chmodSync(path.join(dir, name), fs.statSync(src).mode & 0o777);
  }
  return dir;
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
