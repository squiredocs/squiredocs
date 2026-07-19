/**
 * Feature 021 US1 — runtime kill-switch revert test (DR-2).
 *
 * With globalThis.__SQUIRE_COLLAB_HARDENING__ === false every patched site
 * must execute the VERBATIM stock 3.0.7 code path: the forced-throw repro
 * DELETES from the shared doc again — proving the switch genuinely reverts,
 * not merely "hides" the hardened behavior. Restoring the flag restores
 * hardened behavior in the same process (the patch reads the global LIVE at
 * each decision point). Structural assertion: the patch reads only this one
 * flag global (plus the independent skip-reporter hook).
 *
 * Written BEFORE the patch: RED against stock 3.0.7 (hardened mode absent).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBindingHarness,
  insertRemoteParagraph,
  insertRemoteUnknownNode,
  encodeState,
  bytesEqual,
  yNodeNames,
  flushTimers,
} from '../test/bindingHarness';

let harness;
let errorSpy;

beforeEach(() => {
  delete globalThis.__SQUIRE_COLLAB_HARDENING__;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  if (harness) {
    harness.destroy();
    harness = null;
  }
  await flushTimers();
  errorSpy.mockRestore();
  delete globalThis.__SQUIRE_COLLAB_HARDENING__;
});

function runForcedThrowRepro() {
  const h = createBindingHarness();
  insertRemoteParagraph(h, 'kept');
  h.detachRelay();
  insertRemoteUnknownNode(h, 1);
  const pristine = encodeState(h.remoteDoc);
  h.attachRelay();
  return { h, pristine };
}

describe('021 kill-switch (DR-2): atomic all-four revert to stock', () => {
  it('flag OFF: the forced-throw repro deletes from Y again (stock genuinely restored)', async () => {
    globalThis.__SQUIRE_COLLAB_HARDENING__ = false;
    const { h, pristine } = runForcedThrowRepro();
    harness = h;
    await flushTimers(20);

    // Stock 3.0.7 catch-block behavior: the shared element is DELETED.
    expect(yNodeNames(harness.remoteFragment)).toEqual(['paragraph']);
    expect(bytesEqual(pristine, encodeState(harness.remoteDoc))).toBe(false);
  });

  it('flag back ON in the same process: hardened behavior returns (live read)', async () => {
    globalThis.__SQUIRE_COLLAB_HARDENING__ = false;
    const first = runForcedThrowRepro();
    await flushTimers(20);
    expect(yNodeNames(first.h.remoteFragment)).toEqual(['paragraph']); // stock deleted
    first.h.destroy();

    globalThis.__SQUIRE_COLLAB_HARDENING__ = true;
    const second = runForcedThrowRepro();
    harness = second.h;
    await flushTimers(20);

    // Hardened again: the element survives byte-intact.
    expect(yNodeNames(harness.remoteFragment)).toEqual([
      'paragraph',
      'squireUnknownNode021',
      'paragraph',
    ]);
    expect(bytesEqual(second.pristine, encodeState(harness.remoteDoc))).toBe(true);
  });

  it('unset flag defaults to hardened (fail-safe ON)', async () => {
    // No global at all — e.g. the client-config fetch failed.
    const { h, pristine } = runForcedThrowRepro();
    harness = h;
    await flushTimers(20);
    expect(bytesEqual(pristine, encodeState(harness.remoteDoc))).toBe(true);
    expect(yNodeNames(harness.remoteFragment)).toContain('squireUnknownNode021');
  });

  it('structural: the patch reads only the kill-switch flag and the reporter hook', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dist = path.resolve(
      here,
      '..',
      '..',
      'node_modules',
      '@tiptap',
      'y-tiptap',
      'dist',
      'y-tiptap.js'
    );
    const src = fs.readFileSync(dist, 'utf8');
    const globalsReferenced = new Set(src.match(/__SQUIRE_[A-Z_]+__/g) || []);
    // Guardrail/quarantine independence is structural: the patch can only
    // couple to app state through these two globals.
    expect(globalsReferenced).toEqual(
      new Set(['__SQUIRE_COLLAB_HARDENING__', '__SQUIRE_SKIP_REPORTER__'])
    );
  });
});
