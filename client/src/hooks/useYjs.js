import { useEffect, useState, useRef, useCallback } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';

// Construct WebSocket URL - use /s/ path for server
// IMPORTANT: Must end with trailing slash so y-websocket appends room name correctly
// y-websocket uses: new URL(roomname, serverUrl) which replaces the path without trailing slash
// In production, use same host/port as the page (relative)
// In development, use VITE_WS_URL if set, otherwise use same host/port as page
const getWSUrl = () => {
  if (import.meta.env.VITE_WS_URL) {
    // Ensure trailing slash
    const url = import.meta.env.VITE_WS_URL;
    return url.endsWith('/') ? url : url + '/';
  }
  // Use same host/port as the current page (works for both dev and prod)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/s/`;
};

const WS_URL = getWSUrl();

// Profiling utilities
const PROFILING_ENABLED = true;
const updateTimestamps = new Map(); // Track when updates were sent
let updateCounter = 0;

const logPerf = (label, data = {}) => {
  if (!PROFILING_ENABLED) return;
  const timestamp = performance.now().toFixed(2);
  console.log(`[PERF ${timestamp}ms] ${label}`, data);
};

// Instance cache - stores Yjs instances per document GUID
const instanceCache = new Map();
let indexedDbAvailable = null; // null = not checked, true/false = result

// Helper function to setup provider event listeners
// This is extracted so it can be reused when recreating providers
function setupProviderListeners(provider, ydoc, docGuid) {
  provider.on('status', (event) => {
    logPerf('WS_STATUS', { status: event.status });
    console.log('[useYjs] Provider status:', event.status);
  });

  provider.on('connection-error', (error) => {
    logPerf('WS_ERROR', { error: error.message });
    console.error('[useYjs] Connection error:', error);

    // Detect authentication/authorization failures
    // WebSocket upgrade failures typically manifest as connection errors
    // Common auth error: connection closes immediately without successful handshake
    if (error && error.message) {
      const errorMsg = error.message.toLowerCase();
      if (errorMsg.includes('401') || errorMsg.includes('unauthorized') ||
          errorMsg.includes('403') || errorMsg.includes('forbidden') ||
          errorMsg.includes('auth')) {
        console.error('❌ AUTHENTICATION FAILED - Your session may have expired. Please refresh the page to log in again.');
        logPerf('AUTH_ERROR_DETECTED', { error: error.message });
      }
    }
  });

  // Monitor connection close events for potential auth issues
  provider.on('connection-close', (event) => {
    logPerf('WS_CLOSE_EVENT', { code: event.code, reason: event.reason });

    // WebSocket close codes: 1008 = Policy Violation (often used for auth failures)
    // 1000 = Normal closure, 1001 = Going away, 1006 = Abnormal closure
    if (event.code === 1008 || event.code === 4401 || event.code === 4403) {
      console.error('❌ CONNECTION REJECTED - Authentication or authorization failed. Please refresh the page.');
      logPerf('AUTH_CLOSE_DETECTED', { code: event.code, reason: event.reason });
    }
  });

  // Initialize default title only AFTER sync completes
  // This ensures we don't overwrite an existing title from the server
  let titleInitialized = false;
  provider.on('sync', (isSynced) => {
    logPerf('WS_SYNC', { synced: isSynced });

    if (isSynced && !titleInitialized) {
      titleInitialized = true;
      const meta = ydoc.getMap('meta');
      // Only set default title if server didn't provide one
      if (meta.get('title') === undefined) {
        meta.set('title', 'Untitled Document');
      }
    }
  });
}

// Check if IndexedDB is available (fails in private browsing, some browsers)
// Reduced timeout to 100ms for faster detection
const checkIndexedDbAvailability = async (timeoutMs = 100) => {
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
  instanceCache.clear();
  indexedDbAvailable = null;
  delete global.__TEST_RESET_YJS_SINGLETONS__;
}

// Get or create Yjs instances for a document
function getOrCreateInstances(docGuid, accessToken) {
  // Include token in cache key to reconnect if token changes
  const cacheKey = docGuid;

  if (instanceCache.has(cacheKey)) {
    const cached = instanceCache.get(cacheKey);
    // If token changed, properly recreate the provider with new token
    if (cached.accessToken !== accessToken && cached.provider) {
      console.log(`[useYjs] Token changed for ${docGuid}, recreating provider`);
      cached.accessToken = accessToken;

      // Store current awareness state to restore it after reconnection
      const currentAwarenessState = cached.provider.awareness?.getLocalState();

      // Properly destroy old provider
      cached.provider.destroy();

      // Create new provider with updated token
      const wsParams = accessToken ? { token: accessToken } : {};
      cached.provider = new WebsocketProvider(WS_URL, docGuid, cached.ydoc, {
        connect: true, // On token change, connect immediately (IndexedDB already loaded)
        params: wsParams
      });

      // Setup event listeners on new provider
      setupProviderListeners(cached.provider, cached.ydoc, docGuid);

      // Restore awareness state immediately on new provider
      // y-websocket will sync this to other clients automatically
      if (currentAwarenessState && Object.keys(currentAwarenessState).length > 0) {
        console.log('[useYjs] Restoring awareness state after token change:', Object.keys(currentAwarenessState));
        // Restore entire local state, not just user field
        for (const [key, value] of Object.entries(currentAwarenessState)) {
          cached.provider.awareness.setLocalStateField(key, value);
        }
      }
    }
    return cached;
  }

  console.log(`[useYjs] Creating Yjs document and providers for ${docGuid}`);

  // Create Yjs document
  const ydoc = new Y.Doc();

  // Profile local updates
  ydoc.on('update', (update, origin) => {
    const updateId = ++updateCounter;
    const updateSize = update.byteLength;
    const isLocal = origin === null || origin === ydoc.clientID;

    if (isLocal) {
      updateTimestamps.set(updateId, performance.now());
      logPerf('LOCAL_UPDATE', { updateId, size: updateSize, origin: 'local' });
    } else {
      logPerf('REMOTE_UPDATE', { updateId, size: updateSize, origin: origin?.toString() || 'remote' });
    }
  });

  // Create WebSocket provider with auth token in params
  // NOTE: y-websocket ignores query params in the URL, must use params option
  // IMPORTANT: Start with connect=false, we'll connect after IndexedDB loads
  const wsParams = accessToken ? { token: accessToken } : {};
  const provider = new WebsocketProvider(WS_URL, docGuid, ydoc, {
    connect: false,
    params: wsParams
  });

  // Setup provider event listeners
  setupProviderListeners(provider, ydoc, docGuid);

  // Create IndexedDB provider for offline persistence
  // CRITICAL: Initialize IndexedDB FIRST, then connect WebSocket
  // This ensures local data is fully loaded before network sync begins
  let indexeddbProvider = null;
  (async () => {
    try {
      const isAvailable = await checkIndexedDbAvailability();
      if (!isAvailable) {
        console.log('[useYjs] Skipping IndexedDB persistence (not available)');
        logPerf('INDEXEDDB_SKIP', { reason: 'not available' });
        // Connect WebSocket immediately if IndexedDB not available
        provider.connect();
        return;
      }

      indexeddbProvider = new IndexeddbPersistence(docGuid, ydoc);
      logPerf('INDEXEDDB_INIT', { docGuid });

      // Update cache with indexeddb provider
      const cached = instanceCache.get(docGuid);
      if (cached) {
        cached.indexeddbProvider = indexeddbProvider;
      }

      // Wait for IndexedDB to load local data, then connect WebSocket
      // This prevents race conditions and ensures faster perceived connection time
      indexeddbProvider.once('synced', () => {
        logPerf('INDEXEDDB_SYNCED', {});
        console.log('[useYjs] ✓ IndexedDB synced, connecting WebSocket');
        // Now that local data is loaded, connect to server
        provider.connect();
      });

      // Fallback: If IndexedDB takes too long, connect anyway
      setTimeout(() => {
        if (!provider.wsconnected && !provider.shouldConnect) {
          console.log('[useYjs] IndexedDB sync timeout, connecting WebSocket anyway');
          provider.connect();
        }
      }, 500);

      // Handle IndexedDB errors gracefully
      indexeddbProvider.on('error', (error) => {
        console.warn('[useYjs] IndexedDB error (continuing without local persistence):', error.message);
        logPerf('INDEXEDDB_ERROR', { error: error.message });
        // Connect WebSocket even if IndexedDB fails
        if (!provider.shouldConnect) {
          provider.connect();
        }
      });
    } catch (e) {
      console.warn('[useYjs] Failed to initialize IndexedDB persistence:', e.message);
      logPerf('INDEXEDDB_INIT_FAILED', { error: e.message });
      // Connect WebSocket even if IndexedDB init fails
      provider.connect();
    }
  })();

  const instances = { ydoc, provider, indexeddbProvider, accessToken };
  instanceCache.set(cacheKey, instances);
  return instances;
}

export function useYjs(docGuid, accessToken, user = null) {
  // Connection state: 'connecting' | 'connected' | 'disconnected'
  const [connectionState, setConnectionState] = useState('connecting');
  const [users, setUsers] = useState([]);
  const [synced, setSynced] = useState(false);
  const [docTitle, setDocTitleState] = useState('Untitled Document');
  const [authError, setAuthError] = useState(false); // Track authentication errors
  const instancesRef = useRef(null);
  const lastSyncTimeRef = useRef(Date.now());
  const reconnectCountRef = useRef(0);

  // Get or create instances for this docGuid
  if (!instancesRef.current || instancesRef.current.docGuid !== docGuid) {
    const instances = getOrCreateInstances(docGuid, accessToken);
    instancesRef.current = { ...instances, docGuid };
  }

  // Update token if it changes
  if (instancesRef.current && instancesRef.current.accessToken !== accessToken) {
    getOrCreateInstances(docGuid, accessToken);
  }

  const { ydoc, provider, indexeddbProvider } = instancesRef.current;
  const awareness = provider?.awareness;

  // Set awareness user state SYNCHRONOUSLY during render (not in useEffect)
  // This ensures awareness is set before connection handlers run
  // Critical for production where connection latency can cause race conditions
  if (awareness && user) {
    const currentState = awareness.getLocalState();
    const currentUser = currentState?.user;
    // Only update if user actually changed
    if (!currentUser || currentUser.name !== user.name || currentUser.color !== user.color) {
      console.log('[useYjs] Setting awareness user state (sync):', user.name);
      awareness.setLocalStateField('user', user);
    }
  }

  // Manual reconnection function
  const forceReconnect = useCallback(() => {
    if (!provider) return;
    console.log('[useYjs] Forcing reconnection...');
    reconnectCountRef.current += 1;
    logPerf('FORCE_RECONNECT', { attempt: reconnectCountRef.current });
    provider.disconnect();
    setTimeout(() => {
      provider.connect();
    }, 100);
  }, [provider]);

  useEffect(() => {
    if (!provider) return;

    console.log('[useYjs] Setting up provider listeners', {
      wsconnected: provider.wsconnected,
      synced: provider.synced,
      wsUnsuccessful: provider.wsUnsuccessful,
      shouldConnect: provider.shouldConnect
    });

    const handleStatus = (event) => {
      console.log('[useYjs] Status event:', event.status);
      setConnectionState(event.status);

      // When connected, ensure our awareness state is broadcast
      // This handles the case where awareness was set before connection was established
      if (event.status === 'connected') {
        const localState = awareness.getLocalState();
        if (localState?.user) {
          console.log('[useYjs] Connection established, ensuring awareness is broadcast');
          // Re-setting the same value triggers a broadcast
          awareness.setLocalStateField('user', localState.user);
        }
        // Clear auth error on successful connection
        setAuthError(false);
      }
    };

    const handleConnectionError = (error) => {
      // Detect authentication/authorization failures
      if (error && error.message) {
        const errorMsg = error.message.toLowerCase();
        if (errorMsg.includes('401') || errorMsg.includes('unauthorized') ||
            errorMsg.includes('403') || errorMsg.includes('forbidden') ||
            errorMsg.includes('auth')) {
          console.error('❌ AUTHENTICATION FAILED - Your session may have expired. Please refresh the page to log in again.');
          logPerf('AUTH_ERROR_DETECTED', { error: error.message });
          setAuthError(true);
        }
      }
    };

    const handleConnectionClose = (event) => {
      // WebSocket close codes: 1008 = Policy Violation (often used for auth failures)
      if (event.code === 1008 || event.code === 4401 || event.code === 4403) {
        console.error('❌ CONNECTION REJECTED - Authentication or authorization failed. Please refresh the page.');
        logPerf('AUTH_CLOSE_DETECTED', { code: event.code, reason: event.reason });
        setAuthError(true);
      }
    };

    const handleSync = (isSynced) => {
      console.log('[useYjs] Sync event:', isSynced);
      setSynced(isSynced);
      if (isSynced) {
        lastSyncTimeRef.current = Date.now();
        // Reset reconnect counter on successful sync
        reconnectCountRef.current = 0;

        // y-websocket automatically syncs awareness states after document sync
        // The awareness 'change' event will fire naturally - no manual trigger needed
      }
    };

    const handleAwarenessChange = () => {
      const states = Array.from(awareness.getStates().entries());

      // Debug: Log all awareness states
      console.log('[useYjs] Awareness changed. Total clients:', states.length);
      states.forEach(([clientId, state]) => {
        console.log(`  Client ${clientId}:`, {
          hasUser: !!state.user,
          userName: state.user?.name,
          isAgent: state.user?.isAgent,
          hasCursor: !!state.cursor,
        });
      });

      const userList = states
        .map(([clientId, state]) => {
          if (state.user) {
            return {
              id: clientId,
              name: state.user.name,
              color: state.user.color,
              picture: state.user.picture,
              isAgent: state.user.isAgent
            };
          }
          return null;
        })
        .filter(Boolean);

      console.log('[useYjs] User list after filtering:', userList.length, userList.map(u => u.name));
      setUsers(userList);
    };

    provider.on('status', handleStatus);
    provider.on('sync', handleSync);
    provider.on('connection-error', handleConnectionError);
    provider.on('connection-close', handleConnectionClose);
    awareness.on('change', handleAwarenessChange);

    // Initial status check - determine actual state
    const initialState = provider.wsconnected ? 'connected' : 'connecting';
    const initialSynced = provider.synced || false;
    console.log('[useYjs] Initial state:', { connectionState: initialState, synced: initialSynced });
    setConnectionState(initialState);
    setSynced(initialSynced);

    // Manually trigger awareness change handler to get initial state
    // This ensures we show all connected users immediately
    if (provider.wsconnected && provider.synced) {
      console.log('[useYjs] Provider already connected and synced, getting initial awareness state');
      handleAwarenessChange();
    }

    return () => {
      provider.off('status', handleStatus);
      provider.off('sync', handleSync);
      provider.off('connection-error', handleConnectionError);
      provider.off('connection-close', handleConnectionClose);
      awareness.off('change', handleAwarenessChange);
    };
  }, [provider, awareness]);

  // Connection health monitoring - detect stale connections
  useEffect(() => {
    if (!provider) return;

    const healthCheckInterval = setInterval(() => {
      const timeSinceLastSync = Date.now() - lastSyncTimeRef.current;
      const isConnected = connectionState === 'connected';

      // If we think we're connected but haven't synced in 15 seconds, connection might be stale
      if (isConnected && !synced && timeSinceLastSync > 15000) {
        console.warn('[useYjs] Connection appears stale (no sync for 15s), forcing reconnect');
        logPerf('STALE_CONNECTION_DETECTED', { timeSinceLastSync });
        forceReconnect();
      }

      // Only log health check if there's an issue (connection problems)
      if (connectionState !== 'connected' || !synced) {
        logPerf('HEALTH_CHECK', {
          connectionState,
          synced,
          timeSinceLastSync,
          reconnectCount: reconnectCountRef.current
        });
      }
    }, 30000); // Check every 30 seconds (reduced from 5s for less noise)

    return () => clearInterval(healthCheckInterval);
  }, [provider, connectionState, synced, forceReconnect]);

  // Subscribe to document title changes from the shared metadata map
  useEffect(() => {
    if (!ydoc) return;
    
    const meta = ydoc.getMap('meta');
    
    // Set initial title from shared state
    const currentTitle = meta.get('title');
    if (currentTitle !== undefined) {
      setDocTitleState(currentTitle);
    }
    
    // Listen for changes to the metadata map
    const handleMetaChange = () => {
      const newTitle = meta.get('title');
      if (newTitle !== undefined) {
        setDocTitleState(newTitle);
      }
    };
    
    meta.observe(handleMetaChange);
    
    return () => {
      meta.unobserve(handleMetaChange);
    };
  }, [ydoc, synced]);

  // Function to update the document title (syncs to all clients)
  const setDocTitle = useCallback((newTitle) => {
    if (!ydoc) return;
    const meta = ydoc.getMap('meta');
    meta.set('title', newTitle);
  }, [ydoc]);

  // Cleanup: Clear awareness state when component unmounts (navigating away from document)
  // This ensures your avatar disappears when you leave, while keeping the provider cached
  useEffect(() => {
    return () => {
      if (awareness && typeof awareness.setLocalStateField === 'function') {
        console.log('[useYjs] Component unmounting, clearing awareness fields');
        // Clear user and cursor fields specifically (don't clear entire state)
        awareness.setLocalStateField('user', null);
        awareness.setLocalStateField('cursor', null);
      }
    };
  }, [awareness]);

  return {
    ydoc,
    provider,
    indexeddbProvider,
    awareness,
    connected: connectionState === 'connected', // Backward compatibility
    connectionState, // New: 'connecting' | 'connected' | 'disconnected'
    synced,
    users,
    docGuid,
    docTitle,
    setDocTitle,
    forceReconnect, // New: manual reconnection function
    reconnectCount: reconnectCountRef.current, // New: track reconnection attempts
    authError // New: track authentication errors
  };
}
