const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const WebSocket = require('ws');
const express = require('express');
const crypto = require('crypto');
const { setupWSConnection, setPersistence } = require('y-websocket/bin/utils');
const { createPersistence } = require('../../server/__tests__/helpers/db');

// Make WebSocket available globally for y-websocket in Node.js
global.WebSocket = WebSocket;

const generateTestUUID = () => crypto.randomUUID();

const extractDocGuid = (docName) => {
  if (docName.startsWith('s/')) {
    return docName.slice(2);
  }
  return docName;
};

const ORIGIN_DB_LOAD = 'db-load';

describe('Collaboration Edge Cases', () => {
  let server;
  let wss;
  let persistence;
  let port;

  beforeAll(async () => {
    const app = express();
    await new Promise((resolve) => {
      server = app.listen(0, async () => {
        port = server.address().port;
        wss = new WebSocket.Server({ server });
        persistence = createPersistence();
        
        await persistence._init();
        await persistence.clearAll();
        
        setPersistence({
          bindState: async (docName, ydoc) => {
            const docGuid = extractDocGuid(docName);
            
            ydoc.on('update', (update, origin) => {
              if (origin === ORIGIN_DB_LOAD) return;
              
              persistence.storeUpdate(docGuid, update).catch(err => {
                console.error(`Error persisting update for ${docGuid}:`, err);
              });
            });
            
            try {
              const persistedYdoc = await persistence.getYDoc(docGuid);
              Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc), ORIGIN_DB_LOAD);
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

  test('handles rapid successive edits', (done) => {
    const rapidDocGuid = generateTestUUID();
    const doc = new Y.Doc();
    const text = doc.getText('content');
    
    const provider = new WebsocketProvider(`ws://localhost:${port}/s`, rapidDocGuid, doc, {
      connect: true
    });
    
    provider.on('sync', async (isSynced) => {
      if (isSynced) {
        for (let i = 0; i < 10; i++) {
          text.insert(i * 5, `Char${i}`);
        }
        
        await new Promise(r => setTimeout(r, 100));
        
        expect(text.toString().length).toBeGreaterThan(0);
        provider.destroy();
        done();
      }
    });
  }, 3000);

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
  }, 3000);
});
