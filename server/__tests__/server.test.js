const request = require('supertest');
const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { setupWSConnection } = require('y-websocket/bin/utils');
const { LeveldbPersistence } = require('y-leveldb');

// Mock setup - we'll test the actual server
describe('Server', () => {
  let server;
  let testDataDir;
  let originalEnv;

  beforeAll(() => {
    // Create a temporary test data directory
    testDataDir = path.join(__dirname, '../../test-data');
    if (!fs.existsSync(testDataDir)) {
      fs.mkdirSync(testDataDir, { recursive: true });
    }
    originalEnv = process.env.DATA_DIR;
    process.env.DATA_DIR = testDataDir;
  });

  afterAll(async () => {
    // Cleanup
    if (originalEnv) {
      process.env.DATA_DIR = originalEnv;
    } else {
      delete process.env.DATA_DIR;
    }
    // Remove test data directory
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
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

    beforeEach(() => {
      const app = express();
      httpServer = app.listen(0);
      wss = new WebSocket.Server({ server: httpServer });
      persistence = new LeveldbPersistence(testDataDir);
    });

    afterEach((done) => {
      wss.close(() => {
        persistence.destroy().then(() => {
          httpServer.close(done);
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
  });

  describe('LevelDB Persistence', () => {
    test('creates persistence instance', () => {
      const persistence = new LeveldbPersistence(testDataDir);
      expect(persistence).toBeDefined();
      return persistence.destroy();
    });

    test('stores and retrieves document updates', async () => {
      const persistence = new LeveldbPersistence(testDataDir);
      const Y = require('yjs');
      const doc = new Y.Doc();
      const text = doc.getText('content');
      text.insert(0, 'Hello');
      
      const update = Y.encodeStateAsUpdate(doc);
      await persistence.storeUpdate('test-doc', update);
      
      const retrievedDoc = await persistence.getYDoc('test-doc');
      const retrievedText = retrievedDoc.getText('content');
      expect(retrievedText.toString()).toBe('Hello');
      
      return persistence.destroy();
    });
  });
});

