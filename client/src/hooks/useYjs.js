import { useEffect, useState, useRef } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';

// Construct WebSocket URL - use /s path for server
// In production, use same host/port as the page (relative)
// In development, use VITE_WS_URL if set, otherwise use same host/port as page
const getWSUrl = () => {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }
  // Use same host/port as the current page (works for both dev and prod)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/s`;
};

const WS_URL = getWSUrl();
const DOC_NAME = 'default-doc';

// Profiling utilities
const PROFILING_ENABLED = true;
const updateTimestamps = new Map(); // Track when updates were sent
let updateCounter = 0;

const logPerf = (label, data = {}) => {
  if (!PROFILING_ENABLED) return;
  const timestamp = performance.now().toFixed(2);
  console.log(`[PERF ${timestamp}ms] ${label}`, data);
};

// Singleton instances to prevent React StrictMode from creating duplicates
let globalYdoc = null;
let globalProvider = null;
let globalIndexeddbProvider = null;
let indexedDbAvailable = null; // null = not checked, true/false = result

// Check if IndexedDB is available (fails in private browsing, some browsers)
const checkIndexedDbAvailability = async (timeoutMs = 1000) => {
  if (indexedDbAvailable !== null) return indexedDbAvailable;
  
  try {
    if (typeof indexedDB === 'undefined') {
      console.warn('[useYjs] IndexedDB not available in this environment');
      indexedDbAvailable = false;
      return false;
    }

    // Try to actually open a test database with a timeout
    const testDbName = '__idb_test__';
    const result = await Promise.race([
      new Promise((resolve, reject) => {
        const req = indexedDB.open(testDbName);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          req.result.close();
          // Clean up test database
          indexedDB.deleteDatabase(testDbName);
          resolve(true);
        };
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('IndexedDB timeout')), timeoutMs)
      )
    ]);
    
    indexedDbAvailable = result;
    console.log('[useYjs] IndexedDB available:', result);
    return result;
  } catch (e) {
    console.warn('[useYjs] IndexedDB not available:', e.message);
    indexedDbAvailable = false;
    return false;
  }
};

// For testing: allow resetting singletons
if (typeof global !== 'undefined' && global.__TEST_RESET_YJS_SINGLETONS__) {
  globalYdoc = null;
  globalProvider = null;
  globalIndexeddbProvider = null;
  indexedDbAvailable = null;
  delete global.__TEST_RESET_YJS_SINGLETONS__;
}

export function useYjs() {
  const [connected, setConnected] = useState(false);
  const [users, setUsers] = useState([]);
  const [synced, setSynced] = useState(false);
  const initialized = useRef(false);

  // Initialize singleton instances only once
  if (!initialized.current) {
    initialized.current = true;

    if (!globalYdoc) {
      console.log('[useYjs] Creating Yjs document and providers');

      // Create Yjs document
      globalYdoc = new Y.Doc();

      // Profile local updates
      globalYdoc.on('update', (update, origin) => {
        const updateId = ++updateCounter;
        const updateSize = update.byteLength;
        const isLocal = origin === null || origin === globalYdoc.clientID;
        
        if (isLocal) {
          updateTimestamps.set(updateId, performance.now());
          logPerf('LOCAL_UPDATE', { updateId, size: updateSize, origin: 'local' });
        } else {
          logPerf('REMOTE_UPDATE', { updateId, size: updateSize, origin: origin?.toString() || 'remote' });
        }
      });

      // Create WebSocket provider
      globalProvider = new WebsocketProvider(WS_URL, DOC_NAME, globalYdoc, {
        connect: true
      });

      globalProvider.on('status', (event) => {
        logPerf('WS_STATUS', { status: event.status });
        console.log('[useYjs] Provider status:', event.status);
      });

      globalProvider.on('connection-error', (error) => {
        logPerf('WS_ERROR', { error: error.message });
        console.error('[useYjs] Connection error:', error);
      });

      // Profile WebSocket messages
      const originalWs = globalProvider.ws;
      if (globalProvider.wsconnected && globalProvider.ws) {
        const ws = globalProvider.ws;
        const originalSend = ws.send.bind(ws);
        ws.send = (data) => {
          logPerf('WS_SEND', { size: data.byteLength || data.length });
          return originalSend(data);
        };
      }
      
      globalProvider.on('sync', (isSynced) => {
        logPerf('WS_SYNC', { synced: isSynced });
      });

      // Create IndexedDB provider for offline persistence (async, non-blocking)
      // Don't wait for this - let WebSocket sync proceed immediately
      (async () => {
        try {
          const isAvailable = await checkIndexedDbAvailability();
          if (!isAvailable) {
            console.log('[useYjs] Skipping IndexedDB persistence (not available)');
            logPerf('INDEXEDDB_SKIP', { reason: 'not available' });
            return;
          }

          globalIndexeddbProvider = new IndexeddbPersistence(DOC_NAME, globalYdoc);
          logPerf('INDEXEDDB_INIT', { docName: DOC_NAME });
          
          // Verify IndexedDB persistence after sync
          globalIndexeddbProvider.on('synced', async () => {
            logPerf('INDEXEDDB_SYNCED', {});
            try {
              const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open(DOC_NAME);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });
              
              const stores = Array.from(db.objectStoreNames);
              let totalEntries = 0;
              for (const storeName of stores) {
                const count = await new Promise((resolve, reject) => {
                  const tx = db.transaction([storeName], 'readonly');
                  const store = tx.objectStore(storeName);
                  const req = store.count();
                  req.onsuccess = () => resolve(req.result);
                  req.onerror = () => reject(req.error);
                });
                totalEntries += count;
              }
              console.log(`[useYjs] ✓ IndexedDB synced: ${stores.length} object store(s), ${totalEntries} total entries`);
              db.close();
            } catch (e) {
              console.warn('[useYjs] Could not verify IndexedDB:', e.message);
            }
          });

          // Handle IndexedDB errors gracefully
          globalIndexeddbProvider.on('error', (error) => {
            console.warn('[useYjs] IndexedDB error (continuing without local persistence):', error.message);
            logPerf('INDEXEDDB_ERROR', { error: error.message });
          });
        } catch (e) {
          console.warn('[useYjs] Failed to initialize IndexedDB persistence:', e.message);
          logPerf('INDEXEDDB_INIT_FAILED', { error: e.message });
          // App continues to work via WebSocket sync
        }
      })();
    }
  }

  const ydoc = globalYdoc;
  const provider = globalProvider;
  const indexeddbProvider = globalIndexeddbProvider;
  const awareness = provider?.awareness;

  useEffect(() => {
    if (!provider) return;

    const handleStatus = (event) => {
      setConnected(event.status === 'connected');
    };

    const handleSync = (isSynced) => {
      setSynced(isSynced);
    };

    const handleAwarenessChange = () => {
      const states = Array.from(awareness.getStates().entries());
      const userList = states
        .map(([clientId, state]) => {
          if (state.user) {
            return {
              id: clientId,
              name: state.user.name,
              color: state.user.color
            };
          }
          return null;
        })
        .filter(Boolean);
      setUsers(userList);
    };

    provider.on('status', handleStatus);
    provider.on('sync', handleSync);
    awareness.on('change', handleAwarenessChange);

    // Initial status check
    setConnected(provider.shouldConnect);
    setSynced(provider.shouldConnect);

    return () => {
      provider.off('status', handleStatus);
      provider.off('sync', handleSync);
      awareness.off('change', handleAwarenessChange);
    };
  }, [provider, awareness]);

  // Don't destroy on unmount since we're using singletons
  // They will be cleaned up when the page is closed

  return {
    ydoc,
    provider,
    indexeddbProvider,
    awareness,
    connected,
    synced,
    users,
    docName: provider?.roomname
  };
}

