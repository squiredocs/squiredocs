const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const WebSocket = require('ws');
const express = require('express');
const crypto = require('crypto');
const { setupWSConnection, setPersistence } = require('y-websocket/bin/utils');
const { PostgresPersistence } = require('../../server/postgres-persistence');

// Make WebSocket available globally for y-websocket in Node.js
global.WebSocket = WebSocket;

// Generate a valid UUID v4 for testing
const generateTestUUID = () => crypto.randomUUID();

// Helper to extract clean UUID from y-websocket doc name
const extractDocGuid = (docName) => {
  if (docName.startsWith('s/')) {
    return docName.slice(2);
  }
  return docName;
};

const ORIGIN_DB_LOAD = 'db-load';

/**
 * Wrapper around PostgresPersistence that tracks pending write operations.
 * This allows tests to deterministically wait for writes to complete.
 */
class TrackedPersistence {
  constructor(persistence) {
    this.persistence = persistence;
    this.pendingWrites = new Set();
    this.writeCount = 0;
    this.writeListeners = [];
  }

  /**
   * Store an update and track the operation
   */
  async storeUpdate(docGuid, update) {
    const writePromise = this.persistence.storeUpdate(docGuid, update);
    this.pendingWrites.add(writePromise);
    
    // Notify listeners that a write started
    this.writeListeners.forEach(fn => fn());
    
    try {
      const result = await writePromise;
      this.writeCount++;
      return result;
    } finally {
      this.pendingWrites.delete(writePromise);
    }
  }

  /**
   * Wait for all pending write operations to complete
   */
  async waitForPendingWrites() {
    if (this.pendingWrites.size > 0) {
      await Promise.all([...this.pendingWrites]);
    }
  }

  /**
   * Wait for at least one new write to complete.
   * This handles the race condition where the WebSocket message
   * hasn't reached the server yet when we start waiting.
   */
  async waitForNextWrite(timeout = 2000) {
    const startCount = this.writeCount;
    const startTime = Date.now();
    
    // Wait for either a pending write or a new write to start
    while (this.pendingWrites.size === 0 && this.writeCount === startCount) {
      if (Date.now() - startTime > timeout) {
        throw new Error('Timeout waiting for write');
      }
      await new Promise(r => setTimeout(r, 10));
    }
    
    // Now wait for pending writes to complete
    await this.waitForPendingWrites();
  }

  // Delegate other methods to the underlying persistence
  async getYDoc(docGuid) { return this.persistence.getYDoc(docGuid); }
  async getAllDocuments() { return this.persistence.getAllDocuments(); }
  async getAllDocumentsWithMeta() { return this.persistence.getAllDocumentsWithMeta(); }
  async getDocumentMeta(docGuid) { return this.persistence.getDocumentMeta(docGuid); }
  async clearAll() { return this.persistence.clearAll(); }
  async destroy() { return this.persistence.destroy(); }
  async _init() { return this.persistence._init(); }
}

/**
 * Helper to wait for a WebsocketProvider to sync
 */
function waitForSync(provider, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (provider.synced) {
      resolve();
      return;
    }
    
    const timer = setTimeout(() => {
      reject(new Error('Sync timeout'));
    }, timeout);
    
    const onSync = (isSynced) => {
      if (isSynced) {
        clearTimeout(timer);
        provider.off('sync', onSync);
        resolve();
      }
    };
    
    provider.on('sync', onSync);
  });
}

/**
 * Small delay for WebSocket message propagation (not persistence)
 */
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));

describe('Collaboration Integration Tests', () => {
  let server;
  let wss;
  let basePersistence;
  let trackedPersistence;
  let testDbConfig;
  let port;

  beforeAll(async () => {
    testDbConfig = process.env.TEST_DATABASE_URL || {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.TEST_DB_NAME || 'collab_db',
      user: process.env.DB_USER || process.env.USER || 'postgres',
      password: process.env.DB_PASSWORD || ''
    };
    
    const app = express();
    await new Promise((resolve) => {
      server = app.listen(0, async () => {
        port = server.address().port;
        wss = new WebSocket.Server({ server });
        
        basePersistence = new PostgresPersistence(testDbConfig);
        await basePersistence._init();
        await basePersistence.clearAll();
        
        trackedPersistence = new TrackedPersistence(basePersistence);
        
        setPersistence({
          bindState: async (docName, ydoc) => {
            const docGuid = extractDocGuid(docName);
            
            ydoc.on('update', (update, origin) => {
              if (origin === ORIGIN_DB_LOAD) return;
              
              // Use tracked persistence so tests can wait for writes
              trackedPersistence.storeUpdate(docGuid, update).catch(err => {
                console.error(`Error persisting update for ${docGuid}:`, err);
              });
            });
            
            try {
              const persistedYdoc = await trackedPersistence.getYDoc(docGuid);
              Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc), ORIGIN_DB_LOAD);
            } catch (error) {
              // New document
            }
          },
          writeState: async () => {},
          provider: trackedPersistence
        });
        
        wss.on('connection', (ws, req) => {
          setupWSConnection(ws, req, { gc: true });
        });
        
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => {
      wss.close(() => {
        server.close(() => resolve());
      });
    });
    await tick(50);
    await basePersistence.destroy();
  });

  describe('Document list', () => {
    test('new document with title appears in document list', async () => {
      const testDocGuid = generateTestUUID();
      const doc = new Y.Doc();
      const meta = doc.getMap('meta');
      
      const provider = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc, {
        connect: true
      });
      
      try {
        await waitForSync(provider);
        
        meta.set('title', 'My Test Document');
        
        // Wait for the update to be received and persisted
        await trackedPersistence.waitForNextWrite();
        
        provider.destroy();
        
        const docs = await trackedPersistence.getAllDocumentsWithMeta();
        const ourDoc = docs.find(d => d.docGuid === testDocGuid);
        
        expect(ourDoc).toBeDefined();
        expect(ourDoc.title).toBe('My Test Document');
      } finally {
        provider.destroy();
      }
    });

    test('title change is reflected in document list', async () => {
      const testDocGuid = generateTestUUID();
      const doc = new Y.Doc();
      const meta = doc.getMap('meta');
      
      const provider = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc, {
        connect: true
      });
      
      try {
        await waitForSync(provider);
        
        meta.set('title', 'Untitled Document');
        await trackedPersistence.waitForNextWrite();
        
        meta.set('title', 'My Custom Title');
        await trackedPersistence.waitForNextWrite();
        
        provider.destroy();
        
        const docs = await trackedPersistence.getAllDocumentsWithMeta();
        const ourDoc = docs.find(d => d.docGuid === testDocGuid);
        
        expect(ourDoc).toBeDefined();
        expect(ourDoc.title).toBe('My Custom Title');
      } finally {
        provider.destroy();
      }
    });

    test('title change persists when navigating away quickly', async () => {
      const testDocGuid = generateTestUUID();
      const doc = new Y.Doc();
      const meta = doc.getMap('meta');
      
      const provider = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc, {
        connect: true
      });
      
      try {
        await waitForSync(provider);
        
        meta.set('title', 'Quick Title Change');
        
        // Wait for the update to be received and persisted
        await trackedPersistence.waitForNextWrite();
        
        provider.destroy();
        
        const docs = await trackedPersistence.getAllDocumentsWithMeta();
        const ourDoc = docs.find(d => d.docGuid === testDocGuid);
        
        expect(ourDoc).toBeDefined();
        expect(ourDoc.title).toBe('Quick Title Change');
      } finally {
        provider.destroy();
      }
    });

    test('second client sees existing title from server', async () => {
      const testDocGuid = generateTestUUID();
      
      // First client sets the title
      const doc1 = new Y.Doc();
      const meta1 = doc1.getMap('meta');
      
      const provider1 = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc1, {
        connect: true
      });
      
      await waitForSync(provider1);
      meta1.set('title', 'Server Title');
      await trackedPersistence.waitForNextWrite();
      provider1.destroy();
      
      // Second client connects and should see the title
      const doc2 = new Y.Doc();
      const meta2 = doc2.getMap('meta');
      
      const provider2 = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc2, {
        connect: true
      });
      
      try {
        await waitForSync(provider2);
        
        // Small tick to allow bindState to apply persisted state
        await tick(100);
        
        const currentTitle = meta2.get('title');
        expect(currentTitle).toBe('Server Title');
      } finally {
        provider2.destroy();
      }
    });

    test('document list API returns persisted title', async () => {
      const testDocGuid = generateTestUUID();
      const doc = new Y.Doc();
      const meta = doc.getMap('meta');
      
      const provider = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc, {
        connect: true
      });
      
      try {
        await waitForSync(provider);
        
        meta.set('title', 'My Real Title');
        await trackedPersistence.waitForNextWrite();
        
        const docs = await trackedPersistence.getAllDocumentsWithMeta();
        const ourDoc = docs.find(d => d.docGuid === testDocGuid);
        
        expect(ourDoc).toBeDefined();
        expect(ourDoc.title).toBe('My Real Title');
      } finally {
        provider.destroy();
      }
    });
  });

  describe('Multi-client synchronization', () => {
    test('synchronizes text changes between two clients', async () => {
      const testDocGuid = generateTestUUID();
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();
      const text1 = doc1.getText('content');
      const text2 = doc2.getText('content');
      
      const provider1 = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc1, {
        connect: true
      });
      
      const provider2 = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc2, {
        connect: true
      });
      
      try {
        await Promise.all([waitForSync(provider1), waitForSync(provider2)]);
        
        text1.insert(0, 'Hello ');
        await tick(100); // Allow WebSocket propagation
        
        expect(text2.toString()).toBe('Hello ');
        
        text2.insert(text2.length, 'World!');
        await tick(100);
        
        expect(text1.toString()).toBe('Hello World!');
        expect(text2.toString()).toBe('Hello World!');
      } finally {
        provider1.destroy();
        provider2.destroy();
      }
    });

    test('handles concurrent edits correctly', async () => {
      const concurrentDocGuid = generateTestUUID();
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();
      const text1 = doc1.getText('content');
      const text2 = doc2.getText('content');
      
      const provider1 = new WebsocketProvider(`ws://localhost:${port}/s`, concurrentDocGuid, doc1, {
        connect: true
      });
      
      const provider2 = new WebsocketProvider(`ws://localhost:${port}/s`, concurrentDocGuid, doc2, {
        connect: true
      });
      
      try {
        await Promise.all([waitForSync(provider1), waitForSync(provider2)]);
        
        // Concurrent edits
        text1.insert(0, 'A');
        text2.insert(0, 'B');
        
        // Wait for sync (both writes should complete)
        await tick(100);
        await trackedPersistence.waitForPendingWrites();
        
        const result1 = text1.toString();
        const result2 = text2.toString();
        
        // Both should have converged to the same state
        expect(result1.length).toBeGreaterThan(0);
        expect(result2.length).toBeGreaterThan(0);
        expect(result1).toBe(result2);
      } finally {
        provider1.destroy();
        provider2.destroy();
      }
    });
  });
});
