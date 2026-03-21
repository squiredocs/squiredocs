/**
 * Tests for bridge.js — Host-side orchestration for worker thread execution
 * Tests the full bridge pipeline: spawn worker, stream updates, undo grouping, rollback
 */
const Y = require('yjs');
const { executeInWorker } = require('../bridge');
const { compileTypeScript } = require('../compiler');

// Mock agent-presence to avoid WebSocket dependencies in tests
jest.mock('../../agent-presence', () => ({
  queueHighlightSequence: jest.fn(),
  clearHighlightQueue: jest.fn(() => 0),
}));

const agentPresence = require('../../agent-presence');

describe('Bridge', () => {
  let ydoc;
  let xmlFragment;
  let mockSession;

  beforeEach(() => {
    ydoc = new Y.Doc();
    xmlFragment = ydoc.get('default', Y.XmlFragment);

    mockSession = {
      provider: { doc: ydoc },
      undoManager: new Y.UndoManager(xmlFragment),
      sessionId: 'test-session-bridge',
    };

    jest.clearAllMocks();
  });

  describe('basic execution', () => {
    test('spawns worker and returns success', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'Bridge test');
          p.insert(0, [t]);
          doc.insert(0, [p]);
        }
      `);

      const result = await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 5000 });

      expect(result.success).toBe(true);
      expect(result.operationCount).toBeGreaterThan(0);
      expect(result.summary).toBeDefined();
      expect(result.summary.insert).toBeGreaterThan(0);
    });

    test('applies updates to the live document', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'Live update');
          p.insert(0, [t]);
          doc.insert(0, [p]);
        }
      `);

      await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 5000 });

      expect(xmlFragment.length).toBe(1);
      expect(xmlFragment.get(0).nodeName).toBe('paragraph');

      // Verify text content
      const textNode = xmlFragment.get(0).get(0);
      expect(textNode.toString()).toBe('Live update');
    });
  });

  describe('operation streaming', () => {
    test('streams updates from multiple operations', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          for (let i = 0; i < 5; i++) {
            const p = new Y.XmlElement('paragraph');
            const t = new Y.XmlText();
            t.insert(0, 'Paragraph ' + i);
            p.insert(0, [t]);
            doc.insert(doc.length, [p]);
          }
        }
      `);

      const result = await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 5000 });

      expect(result.success).toBe(true);
      expect(xmlFragment.length).toBe(5);

      // Verify all paragraphs
      for (let i = 0; i < 5; i++) {
        expect(xmlFragment.get(i).nodeName).toBe('paragraph');
      }
    });

    test('preserves formatting in streamed updates', async () => {
      // Pre-populate document
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Bold text here');
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      // Recreate UndoManager so baseline includes existing content
      mockSession.undoManager = new Y.UndoManager(xmlFragment);

      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const block = doc.get(0);
          const textNode = block.get(0);
          textNode.format(0, 4, { bold: true });
        }
      `);

      const result = await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 5000 });

      expect(result.success).toBe(true);

      const updatedText = xmlFragment.get(0).get(0);
      const delta = updatedText.toDelta();
      expect(delta[0].attributes?.bold).toBe(true);
    });
  });

  describe('error handling and rollback', () => {
    test('rolls back on script error', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'Will be rolled back');
          p.insert(0, [t]);
          doc.insert(0, [p]);
          throw new Error('Fail after insert');
        }
      `);

      const result = await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 5000 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Fail after insert');

      // Document should be empty after rollback
      expect(xmlFragment.length).toBe(0);
    });

    test('rolls back on schema validation failure', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const list = new Y.XmlElement('bulletList');
          const para = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'Invalid structure');
          para.insert(0, [t]);
          list.insert(0, [para]); // Invalid: paragraph directly in bulletList
          doc.insert(0, [list]);
        }
      `);

      const result = await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 5000 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid document structure');

      // Document should be rolled back
      expect(xmlFragment.length).toBe(0);
    });

    test('preserves existing content on schema validation failure', async () => {
      // Pre-populate with valid content
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Original content');
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      // Recreate UndoManager so baseline includes existing content
      mockSession.undoManager = new Y.UndoManager(xmlFragment);

      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          doc.delete(0, doc.length);
          const list = new Y.XmlElement('bulletList');
          const badPara = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'Bad');
          badPara.insert(0, [t]);
          list.insert(0, [badPara]);
          doc.insert(0, [list]);
        }
      `);

      const result = await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 5000 });

      expect(result.success).toBe(false);

      // Original content should be restored
      expect(xmlFragment.length).toBe(1);
      expect(xmlFragment.get(0).nodeName).toBe('paragraph');
    });
  });

  describe('timeout enforcement', () => {
    test('terminates worker on timeout', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          while (true) {}
        }
      `);

      const result = await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 100 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    }, 10000);

    test('rolls back partial changes on timeout', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'Before timeout');
          p.insert(0, [t]);
          doc.insert(0, [p]);
          while (true) {}
        }
      `);

      const result = await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 200 });

      expect(result.success).toBe(false);

      // Changes should be rolled back — timeout in the vm.Script happens first
      // and causes an error, which rolls back via undo
      expect(xmlFragment.length).toBe(0);
    }, 10000);
  });

  describe('undo grouping', () => {
    test('all streamed updates are grouped into one undo step', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          for (let i = 0; i < 5; i++) {
            const p = new Y.XmlElement('paragraph');
            const t = new Y.XmlText();
            t.insert(0, 'Para ' + i);
            p.insert(0, [t]);
            doc.insert(doc.length, [p]);
          }
        }
      `);

      const result = await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 5000 });

      expect(result.success).toBe(true);
      expect(xmlFragment.length).toBe(5);

      // One undo should revert ALL changes
      mockSession.undoManager.undo();
      expect(xmlFragment.length).toBe(0);

      // Redo should restore all
      mockSession.undoManager.redo();
      expect(xmlFragment.length).toBe(5);
    });

    test('restores captureTimeout after execution', async () => {
      const originalTimeout = mockSession.undoManager.captureTimeout;

      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          doc.insert(0, [p]);
        }
      `);

      await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 5000 });

      // captureTimeout should be restored to original value
      expect(mockSession.undoManager.captureTimeout).toBe(originalTimeout);
    });

    test('cleans up tracked origin after execution', async () => {
      const origSize = mockSession.undoManager.trackedOrigins.size;

      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          doc.insert(0, [p]);
        }
      `);

      await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 5000 });

      // Should not leak tracked origins
      expect(mockSession.undoManager.trackedOrigins.size).toBe(origSize);
    });
  });

  describe('highlight forwarding', () => {
    test('forwards cursor highlights to agent presence', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'Highlighted');
          p.insert(0, [t]);
          doc.insert(0, [p]);
        }
      `);

      await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 5000 });

      // MutationAggregator should have flushed highlights
      // (the aggregator calls agentPresence.queueHighlightSequence on flush)
      // Exact call count depends on timing, but it should have been called
      expect(agentPresence.queueHighlightSequence).toHaveBeenCalled();
    });
  });

  describe('concurrent document modification', () => {
    test('handles existing document content', async () => {
      // Pre-populate with content
      const para1 = new Y.XmlElement('paragraph');
      const text1 = new Y.XmlText();
      text1.insert(0, 'Existing');
      para1.insert(0, [text1]);
      xmlFragment.insert(0, [para1]);

      mockSession.undoManager = new Y.UndoManager(xmlFragment);

      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'New');
          p.insert(0, [t]);
          doc.insert(doc.length, [p]);
        }
      `);

      const result = await executeInWorker(jsCode, mockSession, xmlFragment, { timeout: 5000 });

      expect(result.success).toBe(true);
      expect(xmlFragment.length).toBe(2);

      // Undo should only revert the new paragraph
      mockSession.undoManager.undo();
      expect(xmlFragment.length).toBe(1);
      expect(xmlFragment.get(0).get(0).toString()).toBe('Existing');
    });
  });
});
