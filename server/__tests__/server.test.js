const request = require('supertest');
const express = require('express');
const WebSocket = require('ws');
const { setupWSConnection } = require('y-websocket/bin/utils');
const { PostgresPersistence } = require('../postgres-persistence');

// Mock setup - we'll test the actual server
describe('Server', () => {
  let testDbConfig;
  let originalEnv;

  beforeAll(() => {
    // Use test database configuration
    // Defaults to test database, can be overridden with TEST_DATABASE_URL
    testDbConfig = process.env.TEST_DATABASE_URL || {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.TEST_DB_NAME || 'collab_test_db',
      user: process.env.DB_USER || process.env.USER || 'postgres',
      password: process.env.DB_PASSWORD || ''
    };
    
    originalEnv = {
      DATABASE_URL: process.env.DATABASE_URL,
      DB_HOST: process.env.DB_HOST,
      DB_PORT: process.env.DB_PORT,
      DB_NAME: process.env.DB_NAME,
      DB_USER: process.env.DB_USER,
      DB_PASSWORD: process.env.DB_PASSWORD
    };
  });

  afterAll(async () => {
    // Restore original environment
    if (originalEnv.DATABASE_URL) {
      process.env.DATABASE_URL = originalEnv.DATABASE_URL;
    } else {
      delete process.env.DATABASE_URL;
    }
    // Restore other env vars similarly if needed
  });

  beforeEach(() => {
    // Reset modules to get fresh server instance
    jest.resetModules();
  });

  describe('HTTP Server', () => {
    let app;
    let httpServer;

    beforeEach(() => {
      app = express();
      app.get('/health', (req, res) => {
        res.status(200).json({ status: 'ok' });
      });
      httpServer = app.listen(0); // Random port
    });

    afterEach((done) => {
      httpServer.close(done);
    });

    test('health check endpoint returns 200 OK', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });
  });

  describe('WebSocket Server', () => {
    let wss;
    let httpServer;
    let persistence;

    beforeEach(async () => {
      const app = express();
      httpServer = app.listen(0);
      wss = new WebSocket.Server({ server: httpServer });
      persistence = new PostgresPersistence(testDbConfig);
      // Ensure database is initialized
      await persistence._init();
      // Clean up any existing test data
      await persistence.clearAll();
    });

    afterEach(async () => {
      return new Promise((resolve) => {
        wss.close(async () => {
          await persistence.destroy();
          httpServer.close(() => {
            resolve();
          });
        });
      });
    });

    test('accepts WebSocket connections', (done) => {
      wss.on('connection', (ws) => {
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
        done();
      });

      const port = httpServer.address().port;
      const ws = new WebSocket(`ws://localhost:${port}/test-doc`);
      
      ws.on('open', () => {
        ws.close();
      });
    });

    test('handles WebSocket connection with setupWSConnection', (done) => {
      wss.on('connection', (ws, req) => {
        try {
          setupWSConnection(ws, req, {
            gc: true,
            persistence: persistence
          });
          expect(ws.readyState).toBe(WebSocket.OPEN);
          ws.close();
          done();
        } catch (error) {
          done(error);
        }
      });

      const port = httpServer.address().port;
      const ws = new WebSocket(`ws://localhost:${port}/test-doc`);
      
      ws.on('open', () => {
        ws.close();
      });
    });

    test('all clients see the same persisted document content', async () => {
      const Y = require('yjs');
      const { WebsocketProvider } = require('y-websocket');
      
      // First, store a document in PostgreSQL
      const persistedDoc = new Y.Doc();
      const persistedText = persistedDoc.getText('content');
      persistedText.insert(0, 'Persisted content from database');
      const persistedUpdate = Y.encodeStateAsUpdate(persistedDoc);
      await persistence.storeUpdate('sync-test-doc', persistedUpdate);
      
      // Verify it's stored
      const retrievedDoc = await persistence.getYDoc('sync-test-doc');
      expect(retrievedDoc.getText('content').toString()).toBe('Persisted content from database');
      
      // Set up WebSocket server with persistence (same as server/index.js)
      const { setPersistence } = require('y-websocket/bin/utils');
      setPersistence({
        bindState: async (docName, ydoc) => {
          try {
            const persistedYdoc = await persistence.getYDoc(docName);
            
            // Store the current (empty) document state first (like y-leveldb does)
            const newUpdates = Y.encodeStateAsUpdate(ydoc);
            await persistence.storeUpdate(docName, newUpdates);
            
            // Apply persisted state to the in-memory document
            Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));
            
            // Set up update listener AFTER applying persisted state (like y-leveldb does)
            ydoc.on('update', update => {
              persistence.storeUpdate(docName, update).catch(err => {
                console.error(`Error persisting update for ${docName}:`, err);
              });
            });
          } catch (error) {
            // If document doesn't exist in persistence, that's okay - start with empty doc
            ydoc.on('update', update => {
              persistence.storeUpdate(docName, update).catch(err => {
                console.error(`Error persisting update for ${docName}:`, err);
              });
            });
          }
        },
        writeState: async (docName, ydoc) => {
          try {
            const update = Y.encodeStateAsUpdate(ydoc);
            await persistence.storeUpdate(docName, update);
          } catch (error) {
            console.error(`Error writing state for ${docName}:`, error);
          }
        },
        provider: persistence
      });
      
      wss.on('connection', (ws, req) => {
        setupWSConnection(ws, req, { gc: true });
      });
      
      const port = httpServer.address().port;
      const WS_URL = `ws://localhost:${port}`;
      
      // Create two clients
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();
      const text1 = doc1.getText('content');
      const text2 = doc2.getText('content');
      
      const provider1 = new WebsocketProvider(WS_URL, 'sync-test-doc', doc1, { connect: true });
      const provider2 = new WebsocketProvider(WS_URL, 'sync-test-doc', doc2, { connect: true });
      
      // Wait for both clients to sync AND receive the persisted content
      // bindState applies persisted updates which trigger 'update' events that get broadcast
      await new Promise((resolve, reject) => {
        const expectedContent = 'Persisted content from database';
        let synced1 = false;
        let synced2 = false;
        const timeout = setTimeout(() => {
          const c1 = text1.toString();
          const c2 = text2.toString();
          reject(new Error(
            `Content timeout - synced1: ${synced1}, synced2: ${synced2}, ` +
            `content1: "${c1}", content2: "${c2}", expected: "${expectedContent}"`
          ));
        }, 10000);
        
        const checkComplete = () => {
          const c1 = text1.toString();
          const c2 = text2.toString();
          
          // Both must be synced AND have the persisted content
          if (synced1 && synced2 && c1 === expectedContent && c2 === expectedContent) {
            clearTimeout(timeout);
            resolve();
          }
        };
        
        // Listen for sync events
        provider1.on('sync', (isSynced) => {
          if (isSynced) {
            synced1 = true;
            checkComplete();
          }
        });
        
        provider2.on('sync', (isSynced) => {
          if (isSynced) {
            synced2 = true;
            checkComplete();
          }
        });
        
        // Also listen for updates in case persisted content arrives after sync
        doc1.on('update', checkComplete);
        doc2.on('update', checkComplete);
      });
      
      // Both clients should see the persisted content
      const content1 = text1.toString();
      const content2 = text2.toString();
      
      expect(content1).toBe('Persisted content from database');
      expect(content2).toBe('Persisted content from database');
      expect(content1).toBe(content2);
      
      // Cleanup
      provider1.destroy();
      provider2.destroy();
      
      // Wait a bit for cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
    }, 15000);
  });

  describe('PostgreSQL Persistence', () => {
    let persistence;

    beforeEach(async () => {
      persistence = new PostgresPersistence(testDbConfig);
      await persistence._init();
      await persistence.clearAll();
    });

    afterEach(async () => {
      await persistence.destroy();
    });

    test('creates persistence instance', () => {
      expect(persistence).toBeDefined();
    });

    test('stores and retrieves document updates', async () => {
      const Y = require('yjs');
      const doc = new Y.Doc();
      const text = doc.getText('content');
      text.insert(0, 'Hello');
      
      const update = Y.encodeStateAsUpdate(doc);
      await persistence.storeUpdate('test-doc', update);
      
      const retrievedDoc = await persistence.getYDoc('test-doc');
      const retrievedText = retrievedDoc.getText('content');
      expect(retrievedText.toString()).toBe('Hello');
    });

    test('handles multiple updates correctly', async () => {
      const Y = require('yjs');
      const doc1 = new Y.Doc();
      const text1 = doc1.getText('content');
      text1.insert(0, 'Hello');
      
      const update1 = Y.encodeStateAsUpdate(doc1);
      await persistence.storeUpdate('test-doc-2', update1);
      
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, update1);
      const text2 = doc2.getText('content');
      text2.insert(text2.length, ' World');
      
      const update2 = Y.encodeStateAsUpdate(doc2);
      await persistence.storeUpdate('test-doc-2', update2);
      
      const retrievedDoc = await persistence.getYDoc('test-doc-2');
      const retrievedText = retrievedDoc.getText('content');
      expect(retrievedText.toString()).toBe('Hello World');
    });
  });
});

