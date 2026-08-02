/**
 * Unit tests for the Yjs XML surgery extracted from `restoreVersion` in
 * feature 042 (FR-010, T034).
 *
 * The code is unchanged by the move (DEC-9), but it had no direct coverage at
 * all before — it was only ever exercised end-to-end through a restore. These
 * tests pin the contract the restore path depends on: a clone is a NEW node
 * carrying the same text, marks, attributes and nesting; non-content nodes are
 * skipped rather than crashing; and a whole-fragment replacement lands as one
 * update.
 *
 * NOTE on reading clones: a freshly cloned node is DETACHED, and Yjs refuses to
 * read a detached type's contents ("Add Yjs type to a document before reading
 * data"). Every assertion below therefore attaches the clone to a document
 * first — which is also exactly what `restoreVersion` does with it.
 */
const Y = require('yjs');
const { cloneXmlNode, replaceFragmentContents } = require('../yjs-utils');

/** A document whose 'default' fragment holds whatever `build` inserts. */
function docWith(build) {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  doc.transact(() => build(fragment));
  return { doc, fragment };
}

/** Attach a detached node to a fresh document so its contents can be read. */
function attach(node) {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  fragment.insert(0, [node]);
  return fragment.get(0);
}

function para(text, attrs = {}) {
  const p = new Y.XmlElement('paragraph');
  for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  return p;
}

describe('cloneXmlNode', () => {
  test('clones a Y.XmlText into a new node with identical text', () => {
    const { fragment } = docWith((f) => {
      const t = new Y.XmlText();
      t.insert(0, 'hello world');
      f.insert(0, [t]);
    });

    const source = fragment.get(0);
    const clone = cloneXmlNode(source);

    expect(clone).toBeInstanceOf(Y.XmlText);
    expect(clone).not.toBe(source);
    expect(attach(clone).toString()).toBe(source.toString());
  });

  test('preserves mark boundaries exactly (the reason applyDelta is used)', () => {
    // Rebuilding this text with successive insert() calls is what makes marks
    // bleed — Yjs inherits the preceding run's attributes. The delta carries
    // the boundary explicitly, so the clone must NOT widen the bold run.
    const { fragment } = docWith((f) => {
      const t = new Y.XmlText();
      t.insert(0, 'plain bold tail');
      t.format(6, 4, { bold: true });
      f.insert(0, [t]);
    });

    const source = fragment.get(0);
    expect(source.toDelta()).toEqual([
      { insert: 'plain ' },
      { insert: 'bold', attributes: { bold: true } },
      { insert: ' tail' },
    ]);

    const clone = attach(cloneXmlNode(source));

    expect(clone.toDelta()).toEqual(source.toDelta());
    const boldOps = clone.toDelta().filter((op) => op.attributes && op.attributes.bold);
    expect(boldOps).toHaveLength(1);
    expect(boldOps[0].insert).toBe('bold'); // no bleed either side
  });

  test('clones a Y.XmlElement with its node name and every attribute', () => {
    const { fragment } = docWith((f) => {
      f.insert(0, [para('Heading text', { level: '2', textAlign: 'center' })]);
    });

    const clone = attach(cloneXmlNode(fragment.get(0)));

    expect(clone).toBeInstanceOf(Y.XmlElement);
    expect(clone.nodeName).toBe('paragraph');
    expect(clone.getAttributes()).toEqual({ level: '2', textAlign: 'center' });
  });

  test('clones nested children recursively', () => {
    const { fragment } = docWith((f) => {
      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      item.insert(0, [para('first'), para('second')]);
      list.insert(0, [item]);
      f.insert(0, [list]);
    });

    const source = fragment.get(0);
    const clone = attach(cloneXmlNode(source));

    expect(clone.length).toBe(1);
    const clonedItem = clone.get(0);
    expect(clonedItem.nodeName).toBe('listItem');
    expect(clonedItem.length).toBe(2);
    expect(clone.toString()).toBe(source.toString());
  });

  test('clones an element with no children', () => {
    const { fragment } = docWith((f) => {
      f.insert(0, [new Y.XmlElement('horizontalRule')]);
    });

    const clone = attach(cloneXmlNode(fragment.get(0)));
    expect(clone).toBeInstanceOf(Y.XmlElement);
    expect(clone.length).toBe(0);
  });

  test('returns null for anything that is not an XmlText or XmlElement', () => {
    expect(cloneXmlNode(null)).toBeNull();
    expect(cloneXmlNode(undefined)).toBeNull();
    expect(cloneXmlNode('a string')).toBeNull();
    expect(cloneXmlNode(new Y.XmlHook('widget'))).toBeNull();
  });
});

describe('replaceFragmentContents', () => {
  test('replaces the target contents with a clone of the source', () => {
    const { fragment: target } = docWith((f) => f.insert(0, [para('old one'), para('old two')]));
    const { fragment: source } = docWith((f) => f.insert(0, [para('new content')]));

    const count = replaceFragmentContents(target, source);

    expect(count).toBe(1);
    expect(target.length).toBe(1);
    expect(target.toString()).toBe(source.toString());
  });

  test('leaves the SOURCE untouched (it is copied, never moved)', () => {
    const { fragment: target } = docWith((f) => f.insert(0, [para('old')]));
    const { fragment: source } = docWith((f) => f.insert(0, [para('a'), para('b')]));

    replaceFragmentContents(target, source);

    expect(source.length).toBe(2);
    expect(source.toString()).toContain('a');
    expect(source.toString()).toContain('b');
  });

  test('empties the target when the source is empty', () => {
    const { fragment: target } = docWith((f) => f.insert(0, [para('old')]));
    const { fragment: source } = docWith(() => {});

    const count = replaceFragmentContents(target, source);

    expect(count).toBe(0);
    expect(target.length).toBe(0);
  });

  test('fills an empty target', () => {
    const { fragment: target } = docWith(() => {});
    const { fragment: source } = docWith((f) => f.insert(0, [para('content')]));

    replaceFragmentContents(target, source);

    expect(target.length).toBe(1);
    expect(target.toString()).toBe(source.toString());
  });

  test('produces ONE update when run inside a transaction (what the restore row is)', () => {
    const { doc: targetDoc, fragment: target } = docWith((f) => f.insert(0, [para('old')]));
    const { fragment: source } = docWith((f) => f.insert(0, [para('new')]));

    // A replica of the PRE-restore state, the way another instance would have it.
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(targetDoc));

    const updates = [];
    targetDoc.on('update', (u) => updates.push(u));
    targetDoc.transact(() => replaceFragmentContents(target, source));

    expect(updates).toHaveLength(1);

    // …and replaying that ONE delta onto the replica reproduces the result —
    // which is exactly how the stored restore row is consumed everywhere else.
    Y.applyUpdate(replica, updates[0]);
    expect(replica.getXmlFragment('default').toString()).toBe(target.toString());
    expect(replica.getXmlFragment('default').toString()).toContain('new');
  });

  test('carries formatting marks across the replacement', () => {
    const { fragment: target } = docWith((f) => f.insert(0, [para('old')]));
    const { fragment: source } = docWith((f) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'italic');
      t.format(0, 6, { italic: true });
      p.insert(0, [t]);
      f.insert(0, [p]);
    });

    replaceFragmentContents(target, source);

    const text = target.get(0).get(0);
    expect(text.toDelta()).toEqual([{ insert: 'italic', attributes: { italic: true } }]);
  });

  test('skips unclonable nodes rather than throwing', () => {
    const { fragment: target } = docWith(() => {});
    const { fragment: source } = docWith((f) => {
      f.insert(0, [para('keep me'), new Y.XmlHook('widget')]);
    });

    const count = replaceFragmentContents(target, source);

    expect(count).toBe(1);
    expect(target.length).toBe(1);
    expect(target.toString()).toContain('keep me');
  });
});
