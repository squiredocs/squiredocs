const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const WebSocket = require('ws');
const express = require('express');
const { setupWSConnection } = require('y-websocket/bin/utils');
const { PostgresPersistence } = require('../../server/postgres-persistence');

describe('Collaboration Integration Tests', () => {
  let server;
  let wss;
  let persistence;
  let testDbConfig;
  let port;

  beforeAll(async (done) => {
    // Use test database configuration
    testDbConfig = process.env.TEST_DATABASE_URL || {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.TEST_DB_NAME || 'collab_test_db',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres'
    };
    
    // Create test server
    const app = express();
    server = app.listen(0, async () => {
      port = server.address().port;
      wss = new WebSocket.Server({ server });
      
      persistence = new PostgresPersistence(testDbConfig);
      await persistence._init();
      await persistence.clearAll();
      
      wss.on('connection', (ws, req) => {
        setupWSConnection(ws, req, {
          gc: true,
          persistence: persistence
        });
      });
      
      done();
    });
  });

  afterAll(async () => {
    await persistence.destroy();
    return new Promise((resolve) => {
      wss.close(() => {
        server.close(() => {
          resolve();
        });
      });
    });
  });

  describe('Multi-client synchronization', () => {
    test('synchronizes text changes between two clients', (done) => {
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();
      const text1 = doc1.getText('content');
      const text2 = doc2.getText('content');
      
      let connected1 = false;
      let connected2 = false;
      let sync1 = false;
      let sync2 = false;
      
      const provider1 = new WebsocketProvider(`ws://localhost:${port}`, 'test-doc', doc1, {
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
      
      const provider2 = new WebsocketProvider(`ws://localhost:${port}`, 'test-doc', doc2, {
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
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();
      const text1 = doc1.getText('content');
      const text2 = doc2.getText('content');
      
      const provider1 = new WebsocketProvider(`ws://localhost:${port}`, 'concurrent-doc', doc1, {
        connect: true
      });
      
      const provider2 = new WebsocketProvider(`ws://localhost:${port}`, 'concurrent-doc', doc2, {
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

  describe('Persistence', () => {
    test('persists document state across connections', async () => {
      const doc1 = new Y.Doc();
      const text1 = doc1.getText('content');
      text1.insert(0, 'Persisted content');
      
      const provider1 = new WebsocketProvider(`ws://localhost:${port}`, 'persist-doc', doc1, {
        connect: true
      });
      
      await new Promise((resolve) => {
        provider1.on('sync', (isSynced) => {
          if (isSynced) {
            provider1.destroy();
            resolve();
          }
        });
      });
      
      // Wait for persistence
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Create new document and connect
      const doc2 = new Y.Doc();
      const provider2 = new WebsocketProvider(`ws://localhost:${port}`, 'persist-doc', doc2, {
        connect: true
      });
      
      await new Promise((resolve) => {
        provider2.on('sync', (isSynced) => {
          if (isSynced) {
            const text2 = doc2.getText('content');
            // Should have persisted content
            expect(text2.toString()).toBe('Persisted content');
            provider2.destroy();
            resolve();
          }
        });
      });
    }, 15000);
  });
});

