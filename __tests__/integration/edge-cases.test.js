const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const WebSocket = require('ws');
const express = require('express');
const { setupWSConnection } = require('y-websocket/bin/utils');
const { LeveldbPersistence } = require('y-leveldb');
const path = require('path');
const fs = require('fs');

describe('Collaboration Edge Cases', () => {
  let server;
  let wss;
  let persistence;
  let testDataDir;
  let port;

  beforeAll((done) => {
    testDataDir = path.join(__dirname, '../../test-data-edge');
    if (!fs.existsSync(testDataDir)) {
      fs.mkdirSync(testDataDir, { recursive: true });
    }
    
    const app = express();
    server = app.listen(0, () => {
      port = server.address().port;
      wss = new WebSocket.Server({ server });
      persistence = new LeveldbPersistence(testDataDir);
      
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
          if (fs.existsSync(testDataDir)) {
            fs.rmSync(testDataDir, { recursive: true, force: true });
          }
          resolve();
        });
      });
    });
  });

  test('handles rapid successive edits', (done) => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    
    const provider = new WebsocketProvider(`ws://localhost:${port}`, 'rapid-doc', doc, {
      connect: true
    });
    
    provider.on('sync', (isSynced) => {
      if (isSynced) {
        // Make rapid edits
        for (let i = 0; i < 10; i++) {
          text.insert(i, `Char${i}`);
        }
        
        setTimeout(() => {
          expect(text.toString().length).toBeGreaterThan(0);
          provider.destroy();
          done();
        }, 1000);
      }
    });
  }, 10000);

  test('handles client disconnection and reconnection', (done) => {
    const doc1 = new Y.Doc();
    const text1 = doc1.getText('content');
    text1.insert(0, 'Initial content');
    
    const provider1 = new WebsocketProvider(`ws://localhost:${port}`, 'reconnect-doc', doc1, {
      connect: true
    });
    
    provider1.on('sync', async (isSynced) => {
      if (isSynced) {
        // Disconnect
        provider1.destroy();
        
        // Wait a bit
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Reconnect with new provider
        const doc2 = new Y.Doc();
        const provider2 = new WebsocketProvider(`ws://localhost:${port}`, 'reconnect-doc', doc2, {
          connect: true
        });
        
        provider2.on('sync', (isSynced2) => {
          if (isSynced2) {
            const text2 = doc2.getText('content');
            // Should have persisted content
            expect(text2.toString()).toBe('Initial content');
            provider2.destroy();
            done();
          }
        });
      }
    });
  }, 15000);

  test('handles empty document correctly', (done) => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://localhost:${port}`, 'empty-doc', doc, {
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

  test('handles very long text content', (done) => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    const longText = 'A'.repeat(10000);
    
    const provider = new WebsocketProvider(`ws://localhost:${port}`, 'long-doc', doc, {
      connect: true
    });
    
    provider.on('sync', (isSynced) => {
      if (isSynced) {
        text.insert(0, longText);
        
        setTimeout(() => {
          expect(text.toString().length).toBe(10000);
          provider.destroy();
          done();
        }, 1000);
      }
    });
  }, 10000);
});

