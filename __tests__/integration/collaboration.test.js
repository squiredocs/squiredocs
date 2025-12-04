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
// y-websocket extracts doc name from URL path like /s/uuid, giving us "s/uuid"
const extractDocGuid = (docName) => {
  if (docName.startsWith('s/')) {
    return docName.slice(2);
  }
  return docName;
};

describe('Collaboration Integration Tests', () => {
  let server;
  let wss;
  let persistence;
  let testDbConfig;
  let port;

  beforeAll(async () => {
    // Use test database configuration
    testDbConfig = process.env.TEST_DATABASE_URL || {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.TEST_DB_NAME || 'collab_db',
      user: process.env.DB_USER || process.env.USER || 'postgres',
      password: process.env.DB_PASSWORD || ''
    };
    
    // Create test server
    const app = express();
    await new Promise((resolve) => {
      server = app.listen(0, async () => {
        port = server.address().port;
        wss = new WebSocket.Server({ server });
        
        persistence = new PostgresPersistence(testDbConfig);
        await persistence._init();
        await persistence.clearAll();
        
        // Set up persistence using setPersistence (not as parameter to setupWSConnection)
        // Note: y-websocket calls it "docName" but we use it as a UUID (docGuid)
        setPersistence({
          bindState: async (docName, ydoc) => {
            const docGuid = extractDocGuid(docName); // Strip s/ prefix from URL path
            try {
              const persistedYdoc = await persistence.getYDoc(docGuid);
              const newUpdates = Y.encodeStateAsUpdate(ydoc);
              await persistence.storeUpdate(docGuid, newUpdates);
              Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));
              ydoc.on('update', update => {
                persistence.storeUpdate(docGuid, update).catch(err => {
                  console.error(`Error persisting update for ${docGuid}:`, err);
                });
              });
            } catch (error) {
              ydoc.on('update', update => {
                persistence.storeUpdate(docGuid, update).catch(err => {
                  console.error(`Error persisting update for ${docGuid}:`, err);
                });
              });
            }
          },
          writeState: async (docName, ydoc) => {
            const docGuid = extractDocGuid(docName);
            try {
              const update = Y.encodeStateAsUpdate(ydoc);
              await persistence.storeUpdate(docGuid, update);
            } catch (error) {
              console.error(`Error writing state for ${docGuid}:`, error);
            }
          },
          provider: persistence
        });
        
        wss.on('connection', (ws, req) => {
          setupWSConnection(ws, req, {
            gc: true
          });
        });
        
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Close WebSocket server first (triggers writeState on pending docs)
    // Then destroy persistence pool
    return new Promise((resolve) => {
      wss.close(() => {
        server.close(async () => {
          // Small delay to let any pending writeState calls complete
          await new Promise(r => setTimeout(r, 100));
          await persistence.destroy();
          resolve();
        });
      });
    });
  });

  describe('Document list', () => {
    test('new document with title appears in document list', (done) => {
      const testDocGuid = generateTestUUID();
      const doc = new Y.Doc();
      
      // Set up the meta map with a title (like the client does)
      const meta = doc.getMap('meta');
      meta.set('title', 'My Test Document');
      
      // Also add some content
      const content = doc.get('default', Y.XmlFragment);
      
      // NOTE: The client connects with the doc GUID, but the URL becomes /s/{guid}
      // y-websocket extracts doc name from the URL path, so we need to ensure
      // the server strips the /s/ prefix before using as doc_guid
      const provider = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc, {
        connect: true
      });
      
      provider.on('sync', async (isSynced) => {
        if (isSynced) {
          // Make an edit to ensure document is persisted
          meta.set('title', 'My Test Document');
          
          // Wait for persistence
          await new Promise(r => setTimeout(r, 500));
          
          // Disconnect (simulates user navigating back to list)
          provider.destroy();
          
          // Wait for writeState to complete
          await new Promise(r => setTimeout(r, 500));
          
          // Now fetch the document list
          const docs = await persistence.getAllDocumentsWithMeta();
          
          // Find our document - should be stored with the clean UUID, not s/uuid
          const ourDoc = docs.find(d => d.docGuid === testDocGuid);
          
          expect(ourDoc).toBeDefined();
          expect(ourDoc.title).toBe('My Test Document');
          
          done();
        }
      });
    }, 15000);
  });

  describe('Multi-client synchronization', () => {
    test('synchronizes text changes between two clients', (done) => {
      const testDocGuid = generateTestUUID();
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();
      const text1 = doc1.getText('content');
      const text2 = doc2.getText('content');
      
      let connected1 = false;
      let connected2 = false;
      let sync1 = false;
      let sync2 = false;
      
      const provider1 = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc1, {
        connect: true
      });
      
      provider1.on('status', (event) => {
        if (event.status === 'connected') {
          connected1 = true;
          checkReady();
        }
      });
      
      provider1.on('sync', (isSynced) => {
        if (isSynced) {
          sync1 = true;
          checkReady();
        }
      });
      
      const provider2 = new WebsocketProvider(`ws://localhost:${port}/s`, testDocGuid, doc2, {
        connect: true
      });
      
      provider2.on('status', (event) => {
        if (event.status === 'connected') {
          connected2 = true;
          checkReady();
        }
      });
      
      provider2.on('sync', (isSynced) => {
        if (isSynced) {
          sync2 = true;
          checkReady();
        }
      });
      
      function checkReady() {
        if (connected1 && connected2 && sync1 && sync2) {
          // Client 1 inserts text
          text1.insert(0, 'Hello ');
          
          setTimeout(() => {
            // Check if client 2 received it
            expect(text2.toString()).toBe('Hello ');
            
            // Client 2 appends text
            text2.insert(text2.length, 'World!');
            
            setTimeout(() => {
              // Check if client 1 received it
              expect(text1.toString()).toBe('Hello World!');
              expect(text2.toString()).toBe('Hello World!');
              
              provider1.destroy();
              provider2.destroy();
              done();
            }, 500);
          }, 500);
        }
      }
    }, 10000);

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
      
      const checkReady = () => {
        if (provider1.shouldConnect && provider2.shouldConnect && !ready) {
          ready = true;
          
          // Both clients insert at the same time
          text1.insert(0, 'A');
          text2.insert(0, 'B');
          
          setTimeout(() => {
            // Yjs CRDT should merge both edits
            const result1 = text1.toString();
            const result2 = text2.toString();
            
            // Both should have both characters (order may vary)
            expect(result1.length).toBeGreaterThan(0);
            expect(result2.length).toBeGreaterThan(0);
            expect(result1).toBe(result2); // Should be synchronized
            
            provider1.destroy();
            provider2.destroy();
            done();
          }, 1000);
        }
      };
      
      provider1.on('sync', checkReady);
      provider2.on('sync', checkReady);
    }, 10000);
  });

});

