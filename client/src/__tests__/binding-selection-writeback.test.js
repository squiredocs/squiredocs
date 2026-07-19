/**
 * Feature 021 US1 — selection-guard + write-back gate repros
 * (SC-002, SC-003, FR-005..007, RBD-3, ANALYZE C1).
 *
 * Incident path (b): stock 3.0.7 calls restoreRelativeSelection unguarded —
 * a throw aborts the remote-change render (stale view) — and the plugin's
 * update() hook then runs the full editor→Yjs diff on the NEXT transaction
 * of any kind, "correcting" the shared doc back to the stale view under the
 * viewer's identity.
 *
 * Written BEFORE the patch: RED against stock 3.0.7 (no seam, ungated diff).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import {
  createBindingHarness,
  insertRemoteParagraph,
  insertRemoteUnknownNode,
  encodeState,
  bytesEqual,
  viewText,
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

describe('021 US1(a): guarded selection restore (FR-005, SC-002)', () => {
  it('exposes the _restoreRelativeSelection seam (patch-added, test-stubbable)', () => {
    harness = createBindingHarness();
    expect(typeof harness.binding._restoreRelativeSelection).toBe('function');
  });

  it('a selection-restore throw no longer aborts the render; selection clamps near', () => {
    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'hello world');
    harness.view.dispatch(
      harness.view.state.tr.setSelection(TextSelection.create(harness.view.state.doc, 6))
    );

    // The seam throws — the guard must catch it and still commit the render.
    harness.binding._restoreRelativeSelection = () => {
      throw new Error('boom: selection restore failed');
    };

    const pristineBefore = encodeState(harness.remoteDoc);
    insertRemoteParagraph(harness, 'fresh remote content');

    // SC-002: render committed with ALL remote content.
    expect(viewText(harness)).toContain('hello world');
    expect(viewText(harness)).toContain('fresh remote content');

    // Selection degraded to a safe clamped position.
    const sel = harness.view.state.selection;
    expect(sel.from).toBeGreaterThanOrEqual(0);
    expect(sel.to).toBeLessThanOrEqual(harness.view.state.doc.content.size);

    // And nothing was written back to the shared doc by the failure handling
    // (only the legitimate remote insert changed it).
    const after = encodeState(harness.remoteDoc);
    expect(after.length).toBeGreaterThan(0);
    expect(bytesEqual(pristineBefore, after)).toBe(false); // remote insert landed
    expect(harness.remoteFragment.toString()).toContain('fresh remote content');
  });

  it('empty-doc case: clamped fallback is valid when remote clears the doc', () => {
    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'about to vanish');
    harness.view.dispatch(
      harness.view.state.tr.setSelection(
        TextSelection.create(harness.view.state.doc, harness.view.state.doc.content.size - 1)
      )
    );
    harness.binding._restoreRelativeSelection = () => {
      throw new Error('boom on empty');
    };

    harness.remoteDoc.transact(() => {
      harness.remoteFragment.delete(0, harness.remoteFragment.length);
    });

    // Render committed (doc emptied), selection clamped into the valid range.
    expect(viewText(harness)).toBe('');
    const sel = harness.view.state.selection;
    expect(sel.from).toBeGreaterThanOrEqual(0);
    expect(sel.to).toBeLessThanOrEqual(harness.view.state.doc.content.size);
  });
});

describe('021 US1(b): THE incident repro — divergence + doc-unchanged transaction (FR-006, SC-003)', () => {
  it('selection-only and metadata-only transactions never write back to Yjs', () => {
    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'existing content');

    // Force view/Yjs divergence: detach the binding's observer so a fresh
    // remote update never renders (the aborted-render state, mechanically).
    harness.binding.type.unobserveDeep(harness.binding._observeFunction);
    insertRemoteParagraph(harness, 'fresh agent content');
    expect(viewText(harness)).not.toContain('fresh agent content'); // stale view

    const pristine = encodeState(harness.remoteDoc);

    // Count editor→Yjs write-backs (local transactions that are not relays).
    let writeBacks = 0;
    const counter = (update, origin) => {
      if (origin !== 'harness-relay') writeBacks += 1;
    };
    harness.localDoc.on('update', counter);

    // The incident trigger: a transaction that does NOT change the doc.
    harness.view.dispatch(
      harness.view.state.tr.setSelection(TextSelection.create(harness.view.state.doc, 1))
    );
    // …and a metadata-only tick.
    harness.view.dispatch(harness.view.state.tr.setMeta('squire-test-tick', true));

    harness.localDoc.off('update', counter);
    harness.binding.type.observeDeep(harness.binding._observeFunction);

    // SC-003: zero write-back, nothing deleted from the shared doc.
    expect(writeBacks).toBe(0);
    expect(bytesEqual(pristine, encodeState(harness.remoteDoc))).toBe(true);
    expect(harness.remoteFragment.toString()).toContain('fresh agent content');
  });
});

describe('021 US1(c): divergence resolution re-renders FROM Yjs (FR-007, RBD-3)', () => {
  it('a render failure marks divergence and resolution converges the view; Y unchanged', async () => {
    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'stable');

    harness.detachRelay();
    insertRemoteUnknownNode(harness, 1);
    const pristine = encodeState(harness.remoteDoc);
    harness.attachRelay(); // render fails on the poison node, marks divergence

    // The patch resolves event-driven divergence via a scheduled re-render
    // from the shared doc; after the flush the divergence flag is cleared.
    await flushTimers(30);
    expect(harness.binding.squireDivergent).toBe(false);

    // Resolution direction is Y→view only: shared doc byte-identical…
    expect(bytesEqual(pristine, encodeState(harness.remoteDoc))).toBe(true);
    expect(yNodeNames(harness.remoteFragment)).toContain('squireUnknownNode021');
    // …and the view still renders everything renderable.
    expect(viewText(harness)).toContain('stable');
  });

  it('explicit _forceRerender converges a stale view without touching Y', async () => {
    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'one');

    harness.binding.type.unobserveDeep(harness.binding._observeFunction);
    insertRemoteParagraph(harness, 'two');
    harness.binding.type.observeDeep(harness.binding._observeFunction);
    expect(viewText(harness)).not.toContain('two');

    const pristine = encodeState(harness.remoteDoc);
    harness.binding._forceRerender();
    await flushTimers(10);

    expect(viewText(harness)).toContain('one');
    expect(viewText(harness)).toContain('two'); // view converged to Y
    expect(bytesEqual(pristine, encodeState(harness.remoteDoc))).toBe(true); // Y unchanged
  });

  it('C1: resolution preserves un-synced local typing (local edits survive)', async () => {
    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'base');

    // Local typing through the normal editing path.
    harness.view.dispatch(harness.view.state.tr.insertText(' TYPED', 5, 5));
    expect(harness.remoteFragment.toString()).toContain('TYPED');

    // Divergence via a render failure, then scheduled resolution.
    harness.detachRelay();
    insertRemoteUnknownNode(harness);
    harness.attachRelay();
    await flushTimers(30);

    // The typing survived resolution — in the view AND the shared doc.
    expect(viewText(harness)).toContain('TYPED');
    expect(harness.remoteFragment.toString()).toContain('TYPED');
    expect(yNodeNames(harness.remoteFragment)).toContain('squireUnknownNode021');
  });
});
