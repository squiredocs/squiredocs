/**
 * Feature 021 — FR-008 / SC-007 dependency-drift survival guard.
 *
 * The binding hardening ships as a patch-package patch on an exact-pinned
 * @tiptap/y-tiptap 3.0.7. This test is the belt to patch-package's
 * --error-on-fail braces: a routine dependency bump (new version, or a
 * reinstall that dropped the patch) fails HERE even if postinstall was
 * somehow bypassed — stock delete-on-render-catch behavior can never
 * silently return.
 *
 * Contract: specs/021-collab-binding-hardening/contracts/binding-patch.md
 * ("Survival guard").
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..', '..');
const pkgDir = path.join(clientRoot, 'node_modules', '@tiptap', 'y-tiptap');

const EXPECTED_VERSION = '3.0.7';

/** The five patched sites — contracts/binding-patch.md sites 1-5. */
const EXPECTED_SENTINELS = [
  'SQUIRE-021:render-catch-element',
  'SQUIRE-021:render-catch-text',
  'SQUIRE-021:selection-guard',
  'SQUIRE-021:writeback-gate',
  'SQUIRE-021:tracked-skip',
];

describe('021 binding patch survival guard (FR-008, SC-007)', () => {
  it(`installed @tiptap/y-tiptap is exactly ${EXPECTED_VERSION}`, () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')
    );
    expect(pkg.version).toBe(EXPECTED_VERSION);
  });

  it('declared as an exact-pinned direct dependency', () => {
    const clientPkg = JSON.parse(
      fs.readFileSync(path.join(clientRoot, 'package.json'), 'utf8')
    );
    expect(clientPkg.dependencies['@tiptap/y-tiptap']).toBe(EXPECTED_VERSION);
    expect(clientPkg.scripts.postinstall).toBe('patch-package --error-on-fail');
  });

  for (const distFile of ['dist/y-tiptap.js', 'dist/y-tiptap.cjs']) {
    it(`${distFile} carries all five SQUIRE-021 sentinels, each exactly once`, () => {
      const src = fs.readFileSync(path.join(pkgDir, distFile), 'utf8');
      for (const sentinel of EXPECTED_SENTINELS) {
        const count = src.split(sentinel).length - 1;
        expect(count, `sentinel ${sentinel} in ${distFile}`).toBe(1);
      }
      // Exactly the expected set — no stray or leftover markers.
      const total = src.split('SQUIRE-021:').length - 1;
      expect(total, `total SQUIRE-021: markers in ${distFile}`).toBe(
        EXPECTED_SENTINELS.length
      );
    });
  }

  it(`committed patch file exists for ${EXPECTED_VERSION}`, () => {
    const patchFile = path.join(
      clientRoot,
      'patches',
      `@tiptap+y-tiptap+${EXPECTED_VERSION}.patch`
    );
    expect(fs.existsSync(patchFile), `${patchFile} must exist`).toBe(true);
  });
});
