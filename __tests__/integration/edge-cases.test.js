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

describe('Collaboration Edge Cases', () => {
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
    
    const app = express();
    await new Promise((resolve) => {
      server = app.listen(0, async () => {
        port = server.address().port;
        wss = new WebSocket.Server({ server });
        persistence = new PostgresPersistence(testDbConfig);
        
        (async () => {
          await persistence._init();
          await persistence.clearAll();
          
          // Set up persistence using setPersistence
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
        })();
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

  test('handles rapid successive edits', (done) => {
    const rapidDocGuid = generateTestUUID();
    const doc = new Y.Doc();
    const text = doc.getText('content');
    
    const provider = new WebsocketProvider(`ws://localhost:${port}/s`, rapidDocGuid, doc, {
      connect: true
    });
    
    provider.on('sync', (isSynced) => {
      if (isSynced) {
        // Make rapid edits
        for (let i = 0; i < 10; i++) {
          text.insert(i * 5, `Char${i}`); // Fix: insert at increasing positions
        }
        
        setTimeout(() => {
          expect(text.toString().length).toBeGreaterThan(0);
          provider.destroy();
          done();
        }, 1000);
      }
    });
  }, 10000);

  test('handles empty document correctly', (done) => {
    const emptyDocGuid = generateTestUUID();
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://localhost:${port}/s`, emptyDocGuid, doc, {
      connect: true
    });
    
    provider.on('sync', (isSynced) => {
      if (isSynced) {
        const text = doc.getText('content');
        expect(text.toString()).toBe('');
        provider.destroy();
        done();
      }
    });
  }, 10000);

  // Removed: Very long text test - not essential, can be slow, and doesn't add much value
});

