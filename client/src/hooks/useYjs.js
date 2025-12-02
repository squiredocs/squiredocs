import { useEffect, useState, useRef } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';

// Construct WebSocket URL - use /s path for server
// In production, use same host/port as the page (relative)
// In development, use VITE_WS_URL if set, otherwise default to localhost:3001
const getWSUrl = () => {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }
  // In production, construct from current location
  if (import.meta.env.PROD) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/s`;
  }
  // In development, default to localhost:3001/s
  return 'ws://localhost:3001/s';
};

const WS_URL = getWSUrl();
const DOC_NAME = 'default-doc';

// Singleton instances to prevent React StrictMode from creating duplicates
let globalYdoc = null;
let globalProvider = null;
let globalIndexeddbProvider = null;

// For testing: allow resetting singletons
if (typeof global !== 'undefined' && global.__TEST_RESET_YJS_SINGLETONS__) {
  globalYdoc = null;
  globalProvider = null;
  globalIndexeddbProvider = null;
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

      // Create WebSocket provider
      globalProvider = new WebsocketProvider(WS_URL, DOC_NAME, globalYdoc, {
        connect: true
      });

      globalProvider.on('status', (event) => {
        console.log('[useYjs] Provider status:', event.status);
      });

      globalProvider.on('connection-error', (error) => {
        console.error('[useYjs] Connection error:', error);
      });

      // Create IndexedDB provider for offline persistence
      globalIndexeddbProvider = new IndexeddbPersistence(DOC_NAME, globalYdoc);
      
      // Verify IndexedDB persistence after sync
      globalIndexeddbProvider.on('synced', async () => {
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
    users
  };
}

