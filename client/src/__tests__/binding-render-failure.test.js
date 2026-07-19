/**
 * Feature 021 US1 — render-failure repros (SC-001, FR-001..004, DR-1).
 *
 * Incident path (a): stock @tiptap/y-tiptap deletes the shared element (or
 * text run) from the Y.Doc inside the render catch-blocks, attributed to the
 * watching viewer. These tests force each failure path through the REAL
 * binding (headless harness, app schema) and assert the shared doc is
 * byte-for-byte unchanged, the remainder renders, logging is bounded
 * (RBD-6), createAndFill stand-ins appear without touching Y (Addition-2),
 * and the tracked-skip exclusion protects skipped nodes from the PM→Y
 * diff's front door (Addition-1) — including the index-translation
 * neighbors case.
 *
 * Written BEFORE the patch: RED against stock 3.0.7 (the deletions happen).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import {
  createBindingHarness,
  insertRemoteParagraph,
  insertRemoteUnknownNode,
  insertRemoteFillableNode,
  insertRemoteUnknownMarkText,
  encodeState,
  bytesEqual,
  viewNodeNames,
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

/** console.error calls mentioning the given needle (bounded-log assertions). */
function logsMentioning(needle) {
  return errorSpy.mock.calls.filter((args) =>
    args.some((a) => {
      try {
        return (typeof a === 'string' ? a : JSON.stringify(a) + String(a && a.message)).includes(needle);
      } catch {
        return false;
      }
    })
  );
}

describe('021 US1(a): forced throwing node — unknown nodeName from remote', () => {
  it('never mutates the shared doc; skips the node; renders the rest; logs once; no loop', async () => {
    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'first paragraph');
    insertRemoteParagraph(harness, 'last paragraph');

    // Build the poison element while the relay is detached so we can capture
    // the shared doc's pristine bytes before the binding sees it.
    harness.detachRelay();
    insertRemoteUnknownNode(harness, 1);
    const pristine = encodeState(harness.remoteDoc);
    harness.attachRelay(); // local render happens here (and fails)

    // FR-001: the shared doc is byte-for-byte unchanged by the failure.
    expect(bytesEqual(pristine, encodeState(harness.remoteDoc))).toBe(true);
    expect(yNodeNames(harness.remoteFragment)).toEqual([
      'paragraph',
      'squireUnknownNode021',
      'paragraph',
    ]);

    // FR-002: only the failing element is skipped; the remainder renders.
    expect(viewText(harness)).toContain('first paragraph');
    expect(viewText(harness)).toContain('last paragraph');
    expect(viewNodeNames(harness)).toEqual(['paragraph', 'paragraph']);

    // FR-003 + RBD-6: one bounded log with node type, doc identity, error.
    const logs = logsMentioning('squireUnknownNode021');
    expect(logs.length).toBe(1);
    const flat = logs[0].map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    expect(flat).toContain('squireUnknownNode021');
    expect(flat).toContain(harness.localDoc.guid);

    // FR-004: repeated remote updates keep skipping without loops or floods.
    const before = encodeState(harness.remoteDoc);
    for (let i = 0; i < 5; i++) {
      harness.remoteDoc.transact(() => {
        harness.remoteFragment.get(0).get(0).insert(0, `u${i} `);
      });
    }
    await flushTimers(30);
    expect(viewText(harness)).toContain('u4');
    expect(logsMentioning('squireUnknownNode021').length).toBe(1); // still once
    expect(yNodeNames(harness.remoteFragment)).toContain('squireUnknownNode021');
    // Only the legitimate text edits changed the doc — the element survived.
    const names = yNodeNames(harness.remoteFragment);
    expect(names).toEqual(['paragraph', 'squireUnknownNode021', 'paragraph']);
    expect(bytesEqual(before, encodeState(harness.remoteDoc))).toBe(false); // edits landed
  });
});

describe('021 US1(b): text-run render failure takes the same log-and-skip path', () => {
  it('skips the run, shared doc byte-identical, bounded log', async () => {
    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'healthy');

    harness.detachRelay();
    insertRemoteUnknownMarkText(harness, 1);
    const pristine = encodeState(harness.remoteDoc);
    harness.attachRelay();

    // FR-001 on the text path: no text._item.delete.
    expect(bytesEqual(pristine, encodeState(harness.remoteDoc))).toBe(true);
    // The marked text is still in the shared doc…
    expect(harness.remoteFragment.toString()).toContain('marked text');
    // …while the view skipped the failing run but kept everything else.
    expect(viewText(harness)).toContain('healthy');
    expect(viewText(harness)).not.toContain('marked text');

    // Bounded log for the text-run failure.
    expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const again = encodeState(harness.remoteDoc);
    harness.remoteDoc.transact(() => {
      harness.remoteFragment.get(0).get(0).insert(0, 'more ');
    });
    await flushTimers(30);
    expect(bytesEqual(again, encodeState(harness.remoteDoc))).toBe(false); // edit landed
    expect(harness.remoteFragment.toString()).toContain('marked text'); // run intact
  });
});

describe('021 US1(c): createAndFill fill-before-skip (DR-1/Addition-2)', () => {
  it('renders a stand-in for a fillable node, Y untouched, pair diff-excluded', async () => {
    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'intro');

    harness.detachRelay();
    insertRemoteFillableNode(harness, 1); // empty bulletList: schema.node throws, createAndFill fills
    const pristine = encodeState(harness.remoteDoc);
    harness.attachRelay();

    // Stand-in appears in the view…
    expect(viewNodeNames(harness)).toEqual(['paragraph', 'bulletList']);
    // …but the shared doc is untouched: still an EMPTY bulletList element.
    expect(bytesEqual(pristine, encodeState(harness.remoteDoc))).toBe(true);
    const yList = harness.remoteFragment.get(1);
    expect(yList.nodeName).toBe('bulletList');
    expect(yList.length).toBe(0);

    // Pair-wise diff exclusion: a legitimate local edit elsewhere must not
    // write the stand-in's filled content into Y, nor delete the Y element.
    harness.view.dispatch(harness.view.state.tr.insertText(' EDIT', 6, 6));
    await flushTimers(30);
    expect(harness.remoteFragment.toString()).toContain('EDIT');
    const yListAfter = harness.remoteFragment.toArray().find((t) => t.nodeName === 'bulletList');
    expect(yListAfter).toBeTruthy();
    expect(yListAfter.length).toBe(0); // stand-in content never written to Y
  });
});

describe('021 US1(d): front-door protection (DR-1/Addition-1, tracked-skip)', () => {
  it('a legitimate local edit elsewhere leaves the skipped node byte-intact in Y', async () => {
    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'alpha');
    insertRemoteParagraph(harness, 'omega');

    harness.detachRelay();
    const poison = insertRemoteUnknownNode(harness, 1);
    poison.setAttribute('data-squire', 'keep-me');
    harness.attachRelay();

    expect(viewNodeNames(harness)).toEqual(['paragraph', 'paragraph']);

    // Legitimate local edit in the last paragraph (after the skipped node).
    const docSize = harness.view.state.doc.content.size;
    harness.view.dispatch(
      harness.view.state.tr.insertText('!', docSize - 1, docSize - 1)
    );
    await flushTimers(30);

    // The edit landed in the right paragraph…
    const yTexts = harness.remoteFragment.toArray().map((t) => t.toString());
    expect(yTexts[2]).toContain('omega!');
    expect(yTexts[0]).toContain('alpha');
    expect(yTexts[0]).not.toContain('!');
    // …and the skipped node SURVIVED with attributes intact.
    const survivor = harness.remoteFragment.get(1);
    expect(survivor.nodeName).toBe('squireUnknownNode021');
    expect(survivor.getAttribute('data-squire')).toBe('keep-me');
  });

  it('neighbors case: edits on BOTH siblings of a skipped node land correctly (index translation)', async () => {
    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'left');
    insertRemoteParagraph(harness, 'right');

    harness.detachRelay();
    insertRemoteUnknownNode(harness, 1);
    harness.attachRelay();

    // One transaction editing both rendered paragraphs around the skip.
    const { state } = harness.view;
    let tr = state.tr;
    // "left" occupies positions 1..5 in paragraph 1; append at its end.
    tr = tr.insertText('L', 5, 5);
    // After that insert, the second paragraph's end shifted by 1.
    const end = tr.doc.content.size - 1;
    tr = tr.insertText('R', end, end);
    harness.view.dispatch(tr);
    await flushTimers(30);

    const names = yNodeNames(harness.remoteFragment);
    expect(names).toEqual(['paragraph', 'squireUnknownNode021', 'paragraph']);
    const texts = harness.remoteFragment.toArray().map((t) => t.toString());
    expect(texts[0]).toContain('leftL');
    expect(texts[2]).toContain('rightR');

    // And a structural local edit: insert a NEW paragraph between the two,
    // from the view's perspective (which cannot see the skipped node).
    const p = harness.schema.nodes.paragraph.createAndFill(
      {},
      harness.schema.text('middle')
    );
    harness.view.dispatch(harness.view.state.tr.insert(7, p));
    await flushTimers(30);

    const namesAfter = yNodeNames(harness.remoteFragment);
    // The skipped node still exists exactly once…
    expect(namesAfter.filter((n) => n === 'squireUnknownNode021')).toHaveLength(1);
    // …and all three paragraphs exist with the right content.
    const allText = harness.remoteFragment.toString();
    expect(allText).toContain('leftL');
    expect(allText).toContain('middle');
    expect(allText).toContain('rightR');
  });
});

describe('021 US1: selection stays valid around skipped content', () => {
  it('cursor can be placed and typed with after a skip without touching the skipped node', async () => {
    harness = createBindingHarness();
    insertRemoteParagraph(harness, 'ab');

    harness.detachRelay();
    insertRemoteUnknownNode(harness, 0);
    harness.attachRelay();

    const sel = TextSelection.create(harness.view.state.doc, 2);
    harness.view.dispatch(harness.view.state.tr.setSelection(sel));
    harness.view.dispatch(harness.view.state.tr.insertText('X'));
    await flushTimers(30);

    expect(harness.remoteFragment.toString()).toContain('aXb');
    expect(yNodeNames(harness.remoteFragment)).toContain('squireUnknownNode021');
  });
});
