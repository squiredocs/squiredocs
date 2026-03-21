/**
 * Tests for worker.js — the worker thread entry point
 * Tests message protocol, count-based batching, and operation serialization
 */
const { Worker } = require('worker_threads');
const path = require('path');
const Y = require('yjs');
const { compileTypeScript } = require('../compiler');

const WORKER_PATH = path.resolve(__dirname, '../worker.js');

/**
 * Helper: spawn worker and collect all messages until exit
 */
function runWorker(jsCode, { snapshot, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const ydoc = new Y.Doc();

    if (!snapshot) {
      snapshot = Buffer.from(Y.encodeStateAsUpdate(ydoc));
    }

    const messages = [];
    const worker = new Worker(WORKER_PATH, {
      workerData: { snapshot, jsCode, timeout },
    });

    worker.on('message', (msg) => messages.push(msg));
    worker.on('error', (err) => reject(err));
    worker.on('exit', (code) => resolve({ messages, code }));
  });
}

describe('Worker Thread', () => {
  describe('message protocol', () => {
    test('sends complete message on successful execution', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'Hello');
          p.insert(0, [t]);
          doc.insert(0, [p]);
        }
      `);

      const { messages, code } = await runWorker(jsCode);

      expect(code).toBe(0);

      const completeMsg = messages.find(m => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      expect(completeMsg.operationCount).toBeGreaterThan(0);
      expect(completeMsg.summary).toBeDefined();
      expect(completeMsg.summary.insert).toBeGreaterThan(0);
    });

    test('sends error message on script failure', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          throw new Error('Intentional test error');
        }
      `);

      const { messages, code } = await runWorker(jsCode);

      expect(code).toBe(0); // Worker exits cleanly even on script error

      const errorMsg = messages.find(m => m.type === 'error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg.error).toContain('Intentional test error');
    });

    test('sends ops messages with Y.Doc updates', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'Test');
          p.insert(0, [t]);
          doc.insert(0, [p]);
        }
      `);

      const { messages } = await runWorker(jsCode);

      const opsMessages = messages.filter(m => m.type === 'ops');
      expect(opsMessages.length).toBeGreaterThan(0);

      // Each ops message should have operations and an update
      for (const msg of opsMessages) {
        expect(msg.operations).toBeDefined();
        expect(Array.isArray(msg.operations)).toBe(true);
        expect(msg.operations.length).toBeGreaterThan(0);
        expect(msg.update).toBeDefined();
      }
    });

    test('ops updates can be applied to reconstruct the document', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'Reconstructed');
          p.insert(0, [t]);
          doc.insert(0, [p]);
        }
      `);

      const ydoc = new Y.Doc();
      const snapshot = Buffer.from(Y.encodeStateAsUpdate(ydoc));
      const { messages } = await runWorker(jsCode, { snapshot });

      // Apply all updates to a fresh doc
      const liveDoc = new Y.Doc();
      const opsMessages = messages.filter(m => m.type === 'ops');
      for (const msg of opsMessages) {
        const update = new Uint8Array(msg.update);
        Y.applyUpdate(liveDoc, update);
      }

      // Verify reconstruction
      const xmlFragment = liveDoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(1);
      expect(xmlFragment.get(0).nodeName).toBe('paragraph');
    });
  });

  describe('count-based batching', () => {
    test('batches operations into groups', async () => {
      // Create a script with many operations to trigger batching
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          for (let i = 0; i < 25; i++) {
            const p = new Y.XmlElement('paragraph');
            const t = new Y.XmlText();
            t.insert(0, 'Line ' + i);
            p.insert(0, [t]);
            doc.insert(doc.length, [p]);
          }
        }
      `);

      const { messages } = await runWorker(jsCode);

      const opsMessages = messages.filter(m => m.type === 'ops');
      // With 25 paragraphs, each needing ~3 mutations (new XmlElement, new XmlText + insert, insert into doc),
      // we should get multiple batches
      expect(opsMessages.length).toBeGreaterThan(1);

      // Total operations across all batches
      const totalOps = opsMessages.reduce((sum, m) => sum + m.operations.length, 0);
      expect(totalOps).toBeGreaterThan(0);
    });

    test('flushes remaining operations on completion', async () => {
      // Script with 3 mutations — fewer than BATCH_SIZE (10),
      // should still produce an ops message on final flush
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'Short');
          p.insert(0, [t]);
          doc.insert(0, [p]);
        }
      `);

      const { messages } = await runWorker(jsCode);

      const opsMessages = messages.filter(m => m.type === 'ops');
      expect(opsMessages.length).toBe(1); // Single flush at completion

      // All 3 mutations in one batch
      expect(opsMessages[0].operations.length).toBe(3);
    });
  });

  describe('operation serialization', () => {
    test('serializes insert operations with correct fields', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'Hello');
          p.insert(0, [t]);
          doc.insert(0, [p]);
        }
      `);

      const { messages } = await runWorker(jsCode);

      const opsMessages = messages.filter(m => m.type === 'ops');
      const allOps = opsMessages.flatMap(m => m.operations);

      // All operations should have required fields
      for (const op of allOps) {
        expect(op.type).toBeDefined();
        expect(op.category).toBe('mutation');
        expect(op.target).toBeDefined();
        expect(op.path).toBeDefined();
        expect(Array.isArray(op.path)).toBe(true);
        expect(op.args).toBeDefined();
        expect(op.timestamp).toBeDefined();
        expect(typeof op.timestamp).toBe('number');
      }

      // Find the XmlText insert
      const textInsert = allOps.find(op =>
        op.type === 'insert' && op.target === 'XmlText'
      );
      expect(textInsert).toBeDefined();
      expect(textInsert.args[0]).toBe(0); // offset
      expect(textInsert.args[1]).toBe('Hello'); // text
    });

    test('serializes format operations', async () => {
      // Pre-populate with text
      const ydoc = new Y.Doc();
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Bold text');
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      const snapshot = Buffer.from(Y.encodeStateAsUpdate(ydoc));

      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const block = doc.get(0);
          const textNode = block.get(0);
          textNode.format(0, 4, { bold: true });
        }
      `);

      const { messages } = await runWorker(jsCode, { snapshot });

      const allOps = messages.filter(m => m.type === 'ops').flatMap(m => m.operations);

      const formatOp = allOps.find(op => op.type === 'format');
      expect(formatOp).toBeDefined();
      expect(formatOp.args[0]).toBe(0); // offset
      expect(formatOp.args[1]).toBe(4); // length
    });

    test('serializes delete operations', async () => {
      const ydoc = new Y.Doc();
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Delete me');
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      const snapshot = Buffer.from(Y.encodeStateAsUpdate(ydoc));

      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const block = doc.get(0);
          const textNode = block.get(0);
          textNode.delete(0, 6);
        }
      `);

      const { messages } = await runWorker(jsCode, { snapshot });

      const allOps = messages.filter(m => m.type === 'ops').flatMap(m => m.operations);

      const deleteOp = allOps.find(op => op.type === 'delete');
      expect(deleteOp).toBeDefined();
      expect(deleteOp.args[0]).toBe(0); // offset
      expect(deleteOp.args[1]).toBe(6); // length
    });
  });

  describe('timeout handling', () => {
    test('times out on infinite loop', async () => {
      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          while (true) {}
        }
      `);

      const { messages, code } = await runWorker(jsCode, { timeout: 100 });

      const errorMsg = messages.find(m => m.type === 'error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg.error).toContain('timed out');
    }, 10000);
  });

  describe('existing document snapshot', () => {
    test('correctly loads and modifies existing document', async () => {
      // Create a document with existing content
      const ydoc = new Y.Doc();
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Original');
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      const snapshot = Buffer.from(Y.encodeStateAsUpdate(ydoc));

      const jsCode = compileTypeScript(`
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'Added');
          p.insert(0, [t]);
          doc.insert(doc.length, [p]);
        }
      `);

      const { messages } = await runWorker(jsCode, { snapshot });

      // Apply all updates to a fresh doc with the same baseline
      const liveDoc = new Y.Doc();
      Y.applyUpdate(liveDoc, new Uint8Array(snapshot));

      const opsMessages = messages.filter(m => m.type === 'ops');
      for (const msg of opsMessages) {
        Y.applyUpdate(liveDoc, new Uint8Array(msg.update));
      }

      const liveFragment = liveDoc.get('default', Y.XmlFragment);
      expect(liveFragment.length).toBe(2);
      expect(liveFragment.get(0).nodeName).toBe('paragraph');
      expect(liveFragment.get(1).nodeName).toBe('paragraph');
    });
  });
});
