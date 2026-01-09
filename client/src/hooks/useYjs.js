import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';

// WebSocket URL construction
const getWSUrl = () => {
  if (import.meta.env.VITE_WS_URL) {
    const url = import.meta.env.VITE_WS_URL;
    return url.endsWith('/') ? url : url + '/';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/s/`;
};

const WS_URL = getWSUrl();

// Simple JWT expiry check
function isTokenExpired(token) {
  if (!token) return true;
  try {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    const decoded = JSON.parse(atob(padded));
    return decoded.exp ? Date.now() >= decoded.exp * 1000 : false;
  } catch {
    return false;
  }
}

// ============================================================================
// DOCUMENT CACHE - Only caches ydoc + IndexedDB (stable, long-lived)
// Provider is NOT cached - it's created fresh when token changes
// ============================================================================
const docCache = new Map();
let indexedDbAvailable = null;

// For testing: allow resetting singletons
if (typeof global !== 'undefined' && global.__TEST_RESET_YJS_SINGLETONS__) {
  docCache.clear();
  indexedDbAvailable = null;
  delete global.__TEST_RESET_YJS_SINGLETONS__;
}

async function checkIndexedDbAvailability() {
  if (indexedDbAvailable !== null) return indexedDbAvailable;
  try {
    if (typeof indexedDB === 'undefined') {
      indexedDbAvailable = false;
      return false;
    }
    const testDbName = '__idb_test__';
    await new Promise((resolve, reject) => {
      const req = indexedDB.open(testDbName);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        req.result.close();
        indexedDB.deleteDatabase(testDbName);
        resolve(true);
      };
      setTimeout(() => reject(new Error('timeout')), 100);
    });
    indexedDbAvailable = true;
    return true;
  } catch {
    indexedDbAvailable = false;
    return false;
  }
}

function getOrCreateDoc(docGuid) {
  if (docCache.has(docGuid)) {
    return docCache.get(docGuid);
  }

  console.log(`[useYjs] Creating new Y.Doc for ${docGuid}`);
  const ydoc = new Y.Doc();
  const cached = { ydoc, indexeddbProvider: null, indexeddbReady: false };
  docCache.set(docGuid, cached);

  // Initialize IndexedDB asynchronously
  checkIndexedDbAvailability().then(available => {
    if (available && docCache.get(docGuid) === cached) {
      cached.indexeddbProvider = new IndexeddbPersistence(docGuid, ydoc);
      cached.indexeddbProvider.once('synced', () => {
        console.log(`[useYjs] IndexedDB synced for ${docGuid}`);
        cached.indexeddbReady = true;
      });
    }
  });

  return cached;
}

// Export for auth failure cleanup
export function clearYjsInstanceCache() {
  console.log('[useYjs] Clearing document cache');
  docCache.forEach(({ ydoc, indexeddbProvider }) => {
    if (indexeddbProvider) indexeddbProvider.destroy();
  });
  docCache.clear();
}

// ============================================================================
// MAIN HOOK - Simplified provider lifecycle
// ============================================================================
export function useYjs(docGuid, accessToken, user = null) {
  // UI State
  const [connectionState, setConnectionState] = useState('connecting');
  const [synced, setSynced] = useState(false);
  const [users, setUsers] = useState([]);
  const [docTitle, setDocTitleState] = useState('Untitled Document');
  const [authError, setAuthError] = useState(false);
  const [reconnectCount, setReconnectCount] = useState(0);
  const [provider, setProvider] = useState(null);

  // Refs
  const providerRef = useRef(null);
  const lastSyncTimeRef = useRef(Date.now());
  const lastForceReconnectRef = useRef(0);

  // Get cached ydoc (stable across re-renders and token changes)
  const { ydoc, indexeddbProvider } = useMemo(() => getOrCreateDoc(docGuid), [docGuid]);

  // ============================================================================
  // PROVIDER LIFECYCLE - Single useEffect manages everything
  // Creates provider when token is available, destroys on cleanup or token change
  // ============================================================================
  useEffect(() => {
    // Don't create provider without valid token
    if (!accessToken) {
      console.log('[useYjs] No token, skipping provider creation');
      setConnectionState('disconnected');
      setAuthError(true);
      return;
    }

    if (isTokenExpired(accessToken)) {
      console.log('[useYjs] Token expired, skipping provider creation');
      setConnectionState('disconnected');
      setAuthError(true);
      return;
    }

    console.log(`[useYjs] Creating provider for ${docGuid}`);
    setAuthError(false);
    setConnectionState('connecting');
    setReconnectCount(0); // Reset on new provider/token

    // Create fresh provider with current token
    const newProvider = new WebsocketProvider(WS_URL, docGuid, ydoc, {
      connect: false, // We'll connect after setup
      params: { token: accessToken },
    });
    providerRef.current = newProvider;
    setProvider(newProvider);

    // Track connection failures for auth detection
    let failureCount = 0;
    const MAX_FAILURES = 2;

    // --- Event Handlers ---
    const handleStatus = (event) => {
      console.log('[useYjs] Status:', event.status);
      setConnectionState(event.status);

      if (event.status === 'connected') {
        setAuthError(false);
        failureCount = 0;
        // Rebroadcast awareness on connect
        const localState = newProvider.awareness.getLocalState();
        if (localState?.user) {
          newProvider.awareness.setLocalStateField('user', localState.user);
        }
      }
    };

    const handleSync = (isSynced) => {
      console.log('[useYjs] Sync:', isSynced);
      setSynced(isSynced);
      if (isSynced) {
        lastSyncTimeRef.current = Date.now();
        failureCount = 0;
        setReconnectCount(0); // Reset on successful sync
        // Initialize title if not set
        const meta = ydoc.getMap('meta');
        if (meta.get('title') === undefined) {
          meta.set('title', 'Untitled Document');
        }
        // Rebroadcast awareness
        const localState = newProvider.awareness.getLocalState();
        if (localState?.user) {
          newProvider.awareness.setLocalStateField('user', localState.user);
        }
        if (localState?.cursor) {
          newProvider.awareness.setLocalStateField('cursor', localState.cursor);
        }
      }
    };

    const handleConnectionError = (error) => {
      console.log('[useYjs] Connection error:', error?.message);

      // Check for auth-related error messages
      const msg = error?.message?.toLowerCase() || '';
      if (msg.includes('401') || msg.includes('unauthorized') ||
          msg.includes('403') || msg.includes('forbidden') || msg.includes('auth')) {
        console.error('[useYjs] Auth error in message:', error?.message);
        setAuthError(true);
        newProvider.shouldConnect = false;
        return;
      }

      // Track failures for implicit auth detection
      failureCount++;
      setReconnectCount(c => c + 1);

      if (failureCount >= MAX_FAILURES) {
        console.error(`[useYjs] ${MAX_FAILURES} connection errors - likely auth issue`);
        setAuthError(true);
        newProvider.shouldConnect = false;
      }
    };

    const handleConnectionClose = (event) => {
      console.log('[useYjs] Connection closed:', event.code, event.reason);

      // Explicit auth failure codes
      if (event.code === 4401 || event.code === 4403) {
        console.error('[useYjs] Auth failure detected');
        setAuthError(true);
        newProvider.shouldConnect = false;
        return;
      }

      // Track failures for implicit auth detection and UI feedback
      failureCount++;
      setReconnectCount(c => c + 1);

      if (failureCount >= MAX_FAILURES) {
        console.error(`[useYjs] ${MAX_FAILURES} connection failures - likely auth issue`);
        setAuthError(true);
        newProvider.shouldConnect = false;
      }
    };

    const handleAwarenessChange = () => {
      const states = Array.from(newProvider.awareness.getStates().entries());
      const userList = states
        .filter(([, state]) => state.user)
        .map(([clientId, state]) => ({
          id: clientId,
          name: state.user.name,
          color: state.user.color,
          picture: state.user.picture,
          isAgent: state.user.isAgent,
        }));
      setUsers(userList);
    };

    // --- Attach Listeners ---
    newProvider.on('status', handleStatus);
    newProvider.on('sync', handleSync);
    newProvider.on('connection-error', handleConnectionError);
    newProvider.on('connection-close', handleConnectionClose);
    newProvider.awareness.on('change', handleAwarenessChange);

    // Set user awareness before connecting
    if (user) {
      newProvider.awareness.setLocalStateField('user', user);
    }

    // Connect (optionally wait for IndexedDB)
    const cached = docCache.get(docGuid);
    if (cached?.indexeddbReady) {
      console.log('[useYjs] IndexedDB ready, connecting immediately');
      newProvider.connect();
    } else {
      // Wait briefly for IndexedDB, then connect anyway
      const timeout = setTimeout(() => {
        if (providerRef.current === newProvider && !newProvider.wsconnected) {
          console.log('[useYjs] IndexedDB wait timeout, connecting');
          newProvider.connect();
        }
      }, 300);

      // Also connect when IndexedDB is ready
      if (cached?.indexeddbProvider) {
        cached.indexeddbProvider.once('synced', () => {
          clearTimeout(timeout);
          if (providerRef.current === newProvider && !newProvider.wsconnected) {
            console.log('[useYjs] IndexedDB synced, connecting');
            newProvider.connect();
          }
        });
      } else {
        // No IndexedDB, connect immediately
        clearTimeout(timeout);
        newProvider.connect();
      }
    }

    // --- Cleanup ---
    return () => {
      console.log(`[useYjs] Destroying provider for ${docGuid}`);
      newProvider.off('status', handleStatus);
      newProvider.off('sync', handleSync);
      newProvider.off('connection-error', handleConnectionError);
      newProvider.off('connection-close', handleConnectionClose);
      newProvider.awareness.off('change', handleAwarenessChange);

      // Clear awareness before destroying
      newProvider.awareness.setLocalStateField('user', null);
      newProvider.awareness.setLocalStateField('cursor', null);

      newProvider.destroy();
      providerRef.current = null;
      setProvider(null);
    };
  }, [docGuid, accessToken, ydoc, user?.name, user?.color]); // Recreate provider when token changes

  // ============================================================================
  // TITLE SYNC
  // ============================================================================
  useEffect(() => {
    if (!ydoc) return;
    const meta = ydoc.getMap('meta');

    const currentTitle = meta.get('title');
    if (currentTitle !== undefined) {
      setDocTitleState(currentTitle);
    }

    const handleMetaChange = () => {
      const newTitle = meta.get('title');
      if (newTitle !== undefined) {
        setDocTitleState(newTitle);
      }
    };

    meta.observe(handleMetaChange);
    return () => meta.unobserve(handleMetaChange);
  }, [ydoc, synced]);

  // ============================================================================
  // VISIBILITY CHANGE - Reconnect on wake from sleep
  // ============================================================================
  useEffect(() => {
    if (!provider) return;

    const handleVisibilityChange = () => {
      if (document.hidden) return;

      const timeSinceSync = Date.now() - lastSyncTimeRef.current;
      if (provider.wsconnected && timeSinceSync > 30000) {
        console.log('[useYjs] Stale connection detected after wake, reconnecting');
        provider.disconnect();
        setTimeout(() => provider.connect(), 100);
      } else if (provider.wsconnected) {
        // Just rebroadcast awareness
        const localState = provider.awareness.getLocalState();
        if (localState?.user) {
          provider.awareness.setLocalStateField('user', localState.user);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [provider]);

  // ============================================================================
  // PAGE UNLOAD - Clean disconnect
  // ============================================================================
  useEffect(() => {
    if (!provider) return;

    const handleBeforeUnload = () => {
      provider.awareness.setLocalStateField('user', null);
      provider.awareness.setLocalStateField('cursor', null);
      provider.disconnect();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [provider]);

  // ============================================================================
  // ACTIONS
  // ============================================================================
  const setDocTitle = useCallback((newTitle) => {
    if (!ydoc) return;
    ydoc.getMap('meta').set('title', newTitle);
  }, [ydoc]);

  const forceReconnect = useCallback(() => {
    if (!provider || !accessToken) return;

    // Debounce: ignore calls within 300ms of last call
    const now = Date.now();
    if (now - lastForceReconnectRef.current < 300) {
      console.log('[useYjs] forceReconnect debounced');
      return;
    }
    lastForceReconnectRef.current = now;

    console.log('[useYjs] Force reconnecting');
    setReconnectCount(c => c + 1);
    provider.disconnect();
    setTimeout(() => provider.connect(), 100);
  }, [provider, accessToken]);

  // ============================================================================
  // RETURN
  // ============================================================================
  return {
    ydoc,
    provider,
    indexeddbProvider,
    awareness: provider?.awareness,
    connected: connectionState === 'connected',
    connectionState,
    synced,
    users,
    docGuid,
    docTitle,
    setDocTitle,
    forceReconnect,
    reconnectCount,
    authError,
  };
}
