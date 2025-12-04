const request = require('supertest');
const express = require('express');
const WebSocket = require('ws');
const Y = require('yjs');
const crypto = require('crypto');
const { setupWSConnection } = require('y-websocket/bin/utils');
const { PostgresPersistence } = require('../postgres-persistence');

// Generate a valid UUID v4 for testing
const generateTestUUID = () => crypto.randomUUID();

describe('Server', () => {
  let testDbConfig;
  let originalEnv;

  beforeAll(() => {
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
      const testDocGuid = generateTestUUID();
      
      wss.on('connection', (ws) => {
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
        done();
      });

      const port = httpServer.address().port;
      const ws = new WebSocket(`ws://localhost:${port}/${testDocGuid}`);
      
      ws.on('open', () => {
        ws.close();
      });
    });

    test('handles WebSocket connection with setupWSConnection', (done) => {
      const testDocGuid = generateTestUUID();
      
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
      const ws = new WebSocket(`ws://localhost:${port}/${testDocGuid}`);
      
      ws.on('open', () => {
        ws.close();
      });
    });

    // Note: This test demonstrates a known timing issue with async bindState
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
      const testDocGuid = generateTestUUID();
      const doc = new Y.Doc();
      const text = doc.getText('content');
      text.insert(0, 'Hello');
      
      const update = Y.encodeStateAsUpdate(doc);
      await persistence.storeUpdate(testDocGuid, update);
      
      const retrievedDoc = await persistence.getYDoc(testDocGuid);
      const retrievedText = retrievedDoc.getText('content');
      expect(retrievedText.toString()).toBe('Hello');
    });

    test('handles multiple updates correctly', async () => {
      const testDocGuid = generateTestUUID();
      const doc1 = new Y.Doc();
      const text1 = doc1.getText('content');
      text1.insert(0, 'Hello');
      
      const update1 = Y.encodeStateAsUpdate(doc1);
      await persistence.storeUpdate(testDocGuid, update1);
      
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, update1);
      const text2 = doc2.getText('content');
      text2.insert(text2.length, ' World');
      
      const update2 = Y.encodeStateAsUpdate(doc2);
      await persistence.storeUpdate(testDocGuid, update2);
      
      const retrievedDoc = await persistence.getYDoc(testDocGuid);
      const retrievedText = retrievedDoc.getText('content');
      expect(retrievedText.toString()).toBe('Hello World');
    });
  });
});

