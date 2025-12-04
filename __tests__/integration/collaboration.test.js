const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const WebSocket = require('ws');
const express = require('express');
const crypto = require('crypto');
const { setupWSConnection, setPersistence } = require('y-websocket/bin/utils');
const { PostgresPersistence } = require('../../server/postgres-persistence');

// Generate a valid UUID v4 for testing
const generateTestUUID = () => crypto.randomUUID();

// Helper to extract clean UUID from y-websocket doc name
const extractDocGuid = (docName) => {
  if (docName.startsWith('s/')) {
    return docName.slice(2);
  }
  return docName;
};

// Short delays for tests - just enough for async operations
const SYNC_DELAY = 100;     // Time for WebSocket message round-trip
const PERSIST_DELAY = 200;  // Time for DB write
const CLEANUP_DELAY = 50;   // Time after disconnect for cleanup

describe('Collaboration Integration Tests', () => {
  let server;
  let wss;
  let persistence;
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
        
        persistence = new PostgresPersistence(testDbConfig);
        await persistence._init();
        await persistence.clearAll();
        
        setPersistence({
          bindState: async (docName, ydoc) => {
            const docGuid = extractDocGuid(docName);
            
            ydoc.on('update', update => {
              persistence.storeUpdate(docGuid, update).catch(err => {
                console.error(`Error persisting update for ${docGuid}:`, err);
              });
            });
            
            try {
              const persistedYdoc = await persistence.getYDoc(docGuid);
              Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));
            } catch (error) {
              // New document
            }
          },
          // writeState intentionally empty - we persist on every update
          writeState: async () => {},
          provider: persistence
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
    // Handle async cleanup after close event completes
    await new Promise(r => setTimeout(r, 50));
    await persistence.destroy();
  });

  describe('Document list', () => {
    test('new document with title appears in document list', (done) => {
      const testDocGuid = generateTestUUID();
      const doc = new Y.Doc();
      const meta = doc.getMap('meta');
      
      const provider = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc, {
        connect: true
      });
      
      let synced = false;
      provider.on('sync', async (isSynced) => {
        if (isSynced && !synced) {
          synced = true;
          
          // Set title after sync (like the real client does)
          meta.set('title', 'My Test Document');
          await new Promise(r => setTimeout(r, PERSIST_DELAY));
          
          provider.destroy();
          await new Promise(r => setTimeout(r, CLEANUP_DELAY));
          
          const docs = await persistence.getAllDocumentsWithMeta();
          const ourDoc = docs.find(d => d.docGuid === testDocGuid);
          
          expect(ourDoc).toBeDefined();
          expect(ourDoc.title).toBe('My Test Document');
          done();
        }
      });
    }, 5000);

    test('title change is reflected in document list', (done) => {
      const testDocGuid = generateTestUUID();
      const doc = new Y.Doc();
      const meta = doc.getMap('meta');
      
      const provider = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc, {
        connect: true
      });
      
      let synced = false;
      provider.on('sync', async (isSynced) => {
        if (isSynced && !synced) {
          synced = true;
          
          if (meta.get('title') === undefined) {
            meta.set('title', 'Untitled Document');
          }
          await new Promise(r => setTimeout(r, SYNC_DELAY));
          
          meta.set('title', 'My Custom Title');
          await new Promise(r => setTimeout(r, PERSIST_DELAY));
          
          provider.destroy();
          await new Promise(r => setTimeout(r, CLEANUP_DELAY));
          
          const docs = await persistence.getAllDocumentsWithMeta();
          const ourDoc = docs.find(d => d.docGuid === testDocGuid);
          
          expect(ourDoc).toBeDefined();
          expect(ourDoc.title).toBe('My Custom Title');
          done();
        }
      });
    }, 5000);

    test('title change persists when navigating away quickly', (done) => {
      const testDocGuid = generateTestUUID();
      const doc = new Y.Doc();
      const meta = doc.getMap('meta');
      
      const provider = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc, {
        connect: true
      });
      
      let synced = false;
      provider.on('sync', async (isSynced) => {
        if (isSynced && !synced) {
          synced = true;
          
          meta.set('title', 'Quick Title Change');
          await new Promise(r => setTimeout(r, SYNC_DELAY));
          
          provider.destroy();
          await new Promise(r => setTimeout(r, CLEANUP_DELAY));
          
          const docs = await persistence.getAllDocumentsWithMeta();
          const ourDoc = docs.find(d => d.docGuid === testDocGuid);
          
          expect(ourDoc).toBeDefined();
          expect(ourDoc.title).toBe('Quick Title Change');
          done();
        }
      });
    }, 5000);

    test('second client sees existing title from server', (done) => {
      const testDocGuid = generateTestUUID();
      const doc1 = new Y.Doc();
      const meta1 = doc1.getMap('meta');
      
      const provider1 = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc1, {
        connect: true
      });
      
      let synced1 = false;
      provider1.on('sync', async (isSynced) => {
        if (isSynced && !synced1) {
          synced1 = true;
          
          meta1.set('title', 'Server Title');
          await new Promise(r => setTimeout(r, PERSIST_DELAY));
          
          provider1.destroy();
          await new Promise(r => setTimeout(r, CLEANUP_DELAY));
          
          // Second client
          const doc2 = new Y.Doc();
          const meta2 = doc2.getMap('meta');
          
          const provider2 = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc2, {
            connect: true
          });
          
          let synced2 = false;
          provider2.on('sync', async (syncedAgain) => {
            if (syncedAgain && !synced2) {
              synced2 = true;
              
              // Wait for bindState to load persisted data
              await new Promise(r => setTimeout(r, PERSIST_DELAY));
              
              if (meta2.get('title') === undefined) {
                meta2.set('title', 'Untitled Document');
              }
              
              const currentTitle = meta2.get('title');
              provider2.destroy();
              
              expect(currentTitle).toBe('Server Title');
              done();
            }
          });
        }
      });
    }, 5000);

    test('document list API returns persisted title', (done) => {
      const testDocGuid = generateTestUUID();
      const doc = new Y.Doc();
      const meta = doc.getMap('meta');
      
      const provider = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc, {
        connect: true
      });
      
      let handled = false;
      provider.on('sync', async (isSynced) => {
        if (isSynced && !handled) {
          handled = true;
          
          try {
            meta.set('title', 'My Real Title');
            await new Promise(r => setTimeout(r, PERSIST_DELAY));
            
            const docs = await persistence.getAllDocumentsWithMeta();
            const ourDoc = docs.find(d => d.docGuid === testDocGuid);
            
            provider.destroy();
            
            expect(ourDoc).toBeDefined();
            expect(ourDoc.title).toBe('My Real Title');
            done();
          } catch (err) {
            provider.destroy();
            done(err);
          }
        }
      });
    }, 5000);
  });

  describe('Multi-client synchronization', () => {
    test('synchronizes text changes between two clients', (done) => {
      const testDocGuid = generateTestUUID();
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();
      const text1 = doc1.getText('content');
      const text2 = doc2.getText('content');
      
      let sync1 = false, sync2 = false;
      
      const provider1 = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc1, {
        connect: true
      });
      
      const provider2 = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc2, {
        connect: true
      });
      
      const checkReady = async () => {
        if (sync1 && sync2) {
          text1.insert(0, 'Hello ');
          await new Promise(r => setTimeout(r, SYNC_DELAY));
          
          expect(text2.toString()).toBe('Hello ');
          
          text2.insert(text2.length, 'World!');
          await new Promise(r => setTimeout(r, SYNC_DELAY));
          
          expect(text1.toString()).toBe('Hello World!');
          expect(text2.toString()).toBe('Hello World!');
          
          provider1.destroy();
          provider2.destroy();
          done();
        }
      };
      
      provider1.on('sync', (isSynced) => { if (isSynced) { sync1 = true; checkReady(); } });
      provider2.on('sync', (isSynced) => { if (isSynced) { sync2 = true; checkReady(); } });
    }, 5000);

    test('handles concurrent edits correctly', (done) => {
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
      
      let ready = false;
      
      const checkReady = async () => {
        if (provider1.synced && provider2.synced && !ready) {
          ready = true;
          
          text1.insert(0, 'A');
          text2.insert(0, 'B');
          
          await new Promise(r => setTimeout(r, PERSIST_DELAY));
          
          const result1 = text1.toString();
          const result2 = text2.toString();
          
          expect(result1.length).toBeGreaterThan(0);
          expect(result2.length).toBeGreaterThan(0);
          expect(result1).toBe(result2);
          
          provider1.destroy();
          provider2.destroy();
          done();
        }
      };
      
      provider1.on('sync', checkReady);
      provider2.on('sync', checkReady);
    }, 5000);
  });
});
