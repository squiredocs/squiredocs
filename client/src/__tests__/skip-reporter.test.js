/**
 * Feature 021 (DR-3) — skip-reporter client.
 *
 * Contract (runtime-config-and-skip-report.md): a forced skip produces
 * EXACTLY ONE report per element per binding instance (the patch dedupes at
 * the source; the reporter batches per doc and debounces); transport failure
 * never throws into the render path; payloads are content-free.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSkipReporter, registerSkipReporter, BINDING_VERSION } from '../utils/skipReporter';
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
  delete globalThis.__SQUIRE_SKIP_REPORTER__;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  if (harness) {
    harness.destroy();
    harness = null;
  }
  await flushTimers();
  errorSpy.mockRestore();
  delete globalThis.__SQUIRE_SKIP_REPORTER__;
  delete globalThis.__SQUIRE_COLLAB_HARDENING__;
});

describe('021 skip reporter (DR-3)', () => {
  it('a forced skip produces exactly one report per element per instance', async () => {
    const api = { post: vi.fn().mockResolvedValue({ status: 204 }) };
    registerSkipReporter(api, { debounceMs: 10 });

    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'body');
    harness.detachRelay();
    insertRemoteUnknownNode(harness, 1);
    harness.attachRelay(); // skip happens (render failure)

    // Repeated remote updates re-skip the same element — deduped at source.
    for (let i = 0; i < 4; i++) {
      harness.remoteDoc.transact(() => {
        harness.remoteFragment.get(0).get(0).insert(0, `t${i} `);
      });
    }
    await flushTimers(60); // past the 10ms debounce

    expect(api.post).toHaveBeenCalledTimes(1);
    const [url, payload] = api.post.mock.calls[0];
    expect(url).toBe('/api/collab/render-skip-report');
    expect(payload.docId).toBe(harness.localDoc.guid);
    expect(payload.bindingVersion).toBe(BINDING_VERSION);
    expect(payload.events).toEqual([
      { nodeType: 'squireUnknownNode021', errorName: 'RangeError', count: 1 },
    ]);
  });

  it('a NEW binding instance re-reports the same failing element (per-instance rule)', async () => {
    const api = { post: vi.fn().mockResolvedValue({ status: 204 }) };
    registerSkipReporter(api, { debounceMs: 10 });

    harness = createBindingHarness();
    harness.detachRelay();
    insertRemoteUnknownNode(harness);
    harness.attachRelay();
    await flushTimers(60);
    expect(api.post).toHaveBeenCalledTimes(1);

    // Editor recreation: destroy and rebind a fresh instance to the same story
    // (a fresh harness models the recreated binding).
    harness.destroy();
    harness = createBindingHarness();
    harness.detachRelay();
    insertRemoteUnknownNode(harness);
    harness.attachRelay();
    await flushTimers(60);
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it('transport failure never throws into the render path (skip still safe)', async () => {
    const api = { post: vi.fn().mockRejectedValue(new Error('beacon down')) };
    registerSkipReporter(api, { debounceMs: 10 });

    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'safe');
    harness.detachRelay();
    insertRemoteUnknownNode(harness, 1);
    const pristine = encodeState(harness.remoteDoc);

    // The render (with its failing node) must complete without throwing…
    expect(() => harness.attachRelay()).not.toThrow();
    await flushTimers(60);

    // …the report was attempted, its failure swallowed, and the shared doc
    // stayed byte-identical.
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(bytesEqual(pristine, encodeState(harness.remoteDoc))).toBe(true);
    expect(yNodeNames(harness.remoteFragment)).toContain('squireUnknownNode021');
  });

  it('a synchronously-throwing transport is also swallowed', async () => {
    const api = {
      post: vi.fn(() => {
        throw new Error('sync transport explosion');
      }),
    };
    registerSkipReporter(api, { debounceMs: 10 });

    harness = createBindingHarness();
    harness.detachRelay();
    insertRemoteUnknownNode(harness);
    expect(() => harness.attachRelay()).not.toThrow();
    await flushTimers(60);
    expect(api.post).toHaveBeenCalled();
  });

  it('batches distinct failures for one doc into a single report', async () => {
    const api = { post: vi.fn().mockResolvedValue({ status: 204 }) };
    const reporter = createSkipReporter(api, { debounceMs: 10 });

    reporter({ docId: 'doc-1', nodeType: 'alpha', errorName: 'RangeError' });
    reporter({ docId: 'doc-1', nodeType: 'beta', errorName: 'TypeError' });
    reporter({ docId: 'doc-1', nodeType: 'alpha', errorName: 'RangeError' }); // aggregated
    await flushTimers(60);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [, payload] = api.post.mock.calls[0];
    expect(payload.events).toEqual([
      { nodeType: 'alpha', errorName: 'RangeError', count: 2 },
      { nodeType: 'beta', errorName: 'TypeError', count: 1 },
    ]);
  });

  it('payloads are content-free: only docId/bindingVersion/events with name/class/count', async () => {
    const api = { post: vi.fn().mockResolvedValue({ status: 204 }) };
    const reporter = createSkipReporter(api, { debounceMs: 10 });
    reporter({ docId: 'doc-2', nodeType: 'gamma', errorName: 'Error' });
    await flushTimers(60);

    const [, payload] = api.post.mock.calls[0];
    expect(Object.keys(payload).sort()).toEqual(['bindingVersion', 'docId', 'events']);
    for (const ev of payload.events) {
      expect(Object.keys(ev).sort()).toEqual(['count', 'errorName', 'nodeType']);
    }
  });
});
