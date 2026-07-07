/**
 * Tests for read-only source documents in the sandbox executor
 * (the `sources` global + cloneBlocks(), backing modify's sourceDocGuids)
 */
const { executeSandboxed } = require('../executor');
const Y = require('yjs');

const GUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Helper: create a Y.Doc snapshot, optionally pre-populated
function createSnapshot(setupFn) {
  const ydoc = new Y.Doc();
  const xmlFragment = ydoc.get('default', Y.XmlFragment);
  if (setupFn) setupFn(xmlFragment);
  return Y.encodeStateAsUpdate(ydoc);
}

// Helper: run a script with sources and collect batches
function collectBatches(snapshot, jsCode, sources = [], timeout = 5000) {
  const batches = [];
  const result = executeSandboxed(
    jsCode,
    snapshot,
    timeout,
    (ops, update) => batches.push({ ops, update: new Uint8Array(update) }),
    null,
    sources
  );
  return { result, batches };
}

// Helper: apply batches to reconstruct the document
function reconstructDoc(snapshot, batches) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(snapshot));
  for (const batch of batches) {
    Y.applyUpdate(doc, batch.update);
  }
  return doc.get('default', Y.XmlFragment);
}

// Build a source snapshot with a heading, a formatted paragraph, and a list
function createRichSourceSnapshot(headingText) {
  return createSnapshot((frag) => {
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', 2);
    const headingTextNode = new Y.XmlText();
    headingTextNode.insert(0, headingText);
    heading.insert(0, [headingTextNode]);

    const para = new Y.XmlElement('paragraph');
    const paraText = new Y.XmlText();
    paraText.insert(0, 'plain and bold text');
    paraText.format(10, 4, { bold: true });
    para.insert(0, [paraText]);

    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    const itemPara = new Y.XmlElement('paragraph');
    const itemText = new Y.XmlText();
    itemText.insert(0, 'item one');
    itemPara.insert(0, [itemText]);
    item.insert(0, [itemPara]);
    list.insert(0, [item]);

    frag.insert(0, [heading, para, list]);
  });
}

describe('Sandbox executor — source documents', () => {
  describe('sources global', () => {
    test('exposes sources keyed by guid, iterable in input order', () => {
      const snapshot = createSnapshot();
      const sources = [
        { docGuid: GUID_B, snapshot: Buffer.from(createRichSourceSnapshot('Doc B')) },
        { docGuid: GUID_A, snapshot: Buffer.from(createRichSourceSnapshot('Doc A')) },
      ];
      const jsCode = `
        exports.default = function(doc) {
          const guids = Object.keys(sources);
          const para = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, guids.join(','));
          para.insert(0, [text]);
          doc.insert(0, [para]);
        };
      `;

      const { batches } = collectBatches(snapshot, jsCode, sources);
      const frag = reconstructDoc(snapshot, batches);
      expect(frag.get(0).get(0).toString()).toBe(`${GUID_B},${GUID_A}`);
    });

    test('sources is an empty object when no sources are passed', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          if (Object.keys(sources).length !== 0) {
            throw new Error('expected empty sources');
          }
        };
      `;

      expect(() => collectBatches(snapshot, jsCode)).not.toThrow();
    });

    test('read helpers work on source documents', () => {
      const snapshot = createSnapshot();
      const sources = [
        { docGuid: GUID_A, snapshot: Buffer.from(createRichSourceSnapshot('Source Heading')) },
      ];
      // Read from the source via helpers, write findings into the target
      const jsCode = `
        exports.default = function(doc) {
          const src = sources['${GUID_A}'];
          const headings = findByNodeName(src, 'heading');
          const headingText = getTextContent(headings[0]);
          const fullText = getTextContent(src);
          const segments = getFormattedContent(xpathFirst('//paragraph', src));
          const boldSegment = segments.find(s => s.attrs && s.attrs.bold);

          const para = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, [headingText, boldSegment.text, fullText.includes('item one')].join('|'));
          para.insert(0, [text]);
          doc.insert(0, [para]);
        };
      `;

      const { batches } = collectBatches(snapshot, jsCode, sources);
      const frag = reconstructDoc(snapshot, batches);
      expect(frag.get(0).get(0).toString()).toBe('Source Heading|bold|true');
    });

    test('xpath with a source context queries the source, not the target', () => {
      const snapshot = createSnapshot((frag) => {
        const para = new Y.XmlElement('paragraph');
        const text = new Y.XmlText();
        text.insert(0, 'target content');
        para.insert(0, [text]);
        frag.insert(0, [para]);
      });
      const sources = [
        { docGuid: GUID_A, snapshot: Buffer.from(createRichSourceSnapshot('Doc A')) },
      ];
      const jsCode = `
        exports.default = function(doc) {
          const srcParas = xpath('//paragraph', sources['${GUID_A}']);
          const targetParas = xpath('//paragraph');
          const para = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, 'src=' + srcParas.length + ' target=' + targetParas.length);
          para.insert(0, [text]);
          doc.insert(doc.length, [para]);
        };
      `;

      const { batches } = collectBatches(snapshot, jsCode, sources);
      const frag = reconstructDoc(snapshot, batches);
      // Source has 2 paragraphs (top-level + inside listItem); target has 1
      expect(frag.get(frag.length - 1).get(0).toString()).toBe('src=2 target=1');
    });
  });

  describe('cloneBlocks', () => {
    test('concatenates a whole source into the target with formatting intact', () => {
      const snapshot = createSnapshot();
      const sources = [
        { docGuid: GUID_A, snapshot: Buffer.from(createRichSourceSnapshot('Cloned Doc')) },
      ];
      const jsCode = `
        exports.default = function(doc) {
          doc.insert(doc.length, cloneBlocks(sources['${GUID_A}']));
        };
      `;

      const { batches } = collectBatches(snapshot, jsCode, sources);
      const frag = reconstructDoc(snapshot, batches);

      expect(frag.length).toBe(3);
      expect(frag.get(0).nodeName).toBe('heading');
      expect(frag.get(0).getAttribute('level')).toBe(2);
      expect(frag.get(0).get(0).toString()).toBe('Cloned Doc');

      // Bold mark survives the clone
      const delta = frag.get(1).get(0).toDelta();
      const boldOp = delta.find(op => op.attributes && op.attributes.bold);
      expect(boldOp.insert).toBe('bold');

      // Nested list structure survives
      expect(frag.get(2).nodeName).toBe('bulletList');
      expect(frag.get(2).get(0).nodeName).toBe('listItem');
      expect(frag.get(2).get(0).get(0).get(0).toString()).toBe('item one');
    });

    test('clones xpath results from a source', () => {
      const snapshot = createSnapshot();
      const sources = [
        { docGuid: GUID_A, snapshot: Buffer.from(createRichSourceSnapshot('Doc A')) },
      ];
      const jsCode = `
        exports.default = function(doc) {
          const headings = xpath('//heading', sources['${GUID_A}']);
          doc.insert(0, cloneBlocks(headings));
        };
      `;

      const { batches } = collectBatches(snapshot, jsCode, sources);
      const frag = reconstructDoc(snapshot, batches);
      expect(frag.length).toBe(1);
      expect(frag.get(0).nodeName).toBe('heading');
      expect(frag.get(0).get(0).toString()).toBe('Doc A');
    });

    test('concatenates multiple sources in input order', () => {
      const snapshot = createSnapshot();
      const sources = [
        { docGuid: GUID_B, snapshot: Buffer.from(createRichSourceSnapshot('First')) },
        { docGuid: GUID_A, snapshot: Buffer.from(createRichSourceSnapshot('Second')) },
      ];
      const jsCode = `
        exports.default = function(doc) {
          for (const guid of Object.keys(sources)) {
            doc.insert(doc.length, cloneBlocks(sources[guid]));
          }
        };
      `;

      const { batches } = collectBatches(snapshot, jsCode, sources);
      const frag = reconstructDoc(snapshot, batches);
      expect(frag.length).toBe(6);
      expect(frag.get(0).get(0).toString()).toBe('First');
      expect(frag.get(3).get(0).toString()).toBe('Second');
    });
  });

  describe('read-only enforcement', () => {
    test.each([
      ['insert on the fragment', `src.insert(0, [new Y.XmlElement('paragraph')])`],
      ['delete on the fragment', `src.delete(0, 1)`],
      ['setAttribute on a child element', `src.get(0).setAttribute('level', 1)`],
      ['delete on a nested node from toArray()', `src.toArray()[0].delete(0, 1)`],
      ['format on a text node from xpath', `xpathFirst('//paragraph', src).get(0).format(0, 5, { bold: true })`],
    ])('%s throws a read-only error', (_label, mutation) => {
      const snapshot = createSnapshot();
      const sources = [
        { docGuid: GUID_A, snapshot: Buffer.from(createRichSourceSnapshot('Doc A')) },
      ];
      const jsCode = `
        exports.default = function(doc) {
          const src = sources['${GUID_A}'];
          ${mutation};
        };
      `;

      expect(() => collectBatches(snapshot, jsCode, sources))
        .toThrow(new RegExp(`Source document ${GUID_A} is read-only`));
    });

    test('a failed mutation attempt streams no updates to the target', () => {
      const snapshot = createSnapshot();
      const sources = [
        { docGuid: GUID_A, snapshot: Buffer.from(createRichSourceSnapshot('Doc A')) },
      ];
      const jsCode = `
        exports.default = function(doc) {
          sources['${GUID_A}'].delete(0, 1);
        };
      `;

      const batches = [];
      expect(() => executeSandboxed(
        jsCode, snapshot, 5000,
        (ops, update) => batches.push(update), null, sources
      )).toThrow(/read-only/);
      expect(batches).toHaveLength(0);
    });
  });
});
