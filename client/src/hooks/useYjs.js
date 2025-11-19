import { useEffect, useState, useRef } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';
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

