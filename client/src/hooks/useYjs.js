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
        connect: true,
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
  const wsParams = accessToken ? { token: accessToken } : {};
  const provider = new WebsocketProvider(WS_URL, docGuid, ydoc, {
    connect: true,
    params: wsParams
  });

  // Setup provider event listeners
  setupProviderListeners(provider, ydoc, docGuid);

  // Create IndexedDB provider for offline persistence (async, non-blocking)
  let indexeddbProvider = null;
  (async () => {
    try {
      const isAvailable = await checkIndexedDbAvailability();
      if (!isAvailable) {
        console.log('[useYjs] Skipping IndexedDB persistence (not available)');
        logPerf('INDEXEDDB_SKIP', { reason: 'not available' });
        return;
      }

      indexeddbProvider = new IndexeddbPersistence(docGuid, ydoc);
      logPerf('INDEXEDDB_INIT', { docGuid });
      
      // Update cache with indexeddb provider
      const cached = instanceCache.get(docGuid);
      if (cached) {
        cached.indexeddbProvider = indexeddbProvider;
      }
      
      // Verify IndexedDB persistence after sync
      indexeddbProvider.on('synced', async () => {
        logPerf('INDEXEDDB_SYNCED', {});
        try {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(docGuid);
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
      indexeddbProvider.on('error', (error) => {
        console.warn('[useYjs] IndexedDB error (continuing without local persistence):', error.message);
        logPerf('INDEXEDDB_ERROR', { error: error.message });
      });
    } catch (e) {
      console.warn('[useYjs] Failed to initialize IndexedDB persistence:', e.message);
      logPerf('INDEXEDDB_INIT_FAILED', { error: e.message });
      // App continues to work via WebSocket sync
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
  const instancesRef = useRef(null);
  const lastSyncTimeRef = useRef(Date.now());
  const reconnectCountRef = useRef(0);
  const previousUserRef = useRef(null);

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

  // Set awareness user state immediately when user info is available or changes
  // This ensures awareness is always set before any rendering happens
  useEffect(() => {
    if (awareness && user) {
      // Only update if user actually changed (avoid unnecessary updates)
      const userChanged = JSON.stringify(previousUserRef.current) !== JSON.stringify(user);
      if (userChanged) {
        console.log('[useYjs] Setting awareness user state:', user);
        awareness.setLocalStateField('user', user);
        previousUserRef.current = user;
      }
    }
  }, [awareness, user]);

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

      // Trust y-websocket's built-in awareness sync - it handles everything automatically
      // Awareness state is set once by CollaborationCursorWithSelection and persists
      // y-websocket syncs it to all clients without manual intervention
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

      // Log connection health status periodically
      logPerf('HEALTH_CHECK', {
        connectionState,
        synced,
        timeSinceLastSync,
        reconnectCount: reconnectCountRef.current
      });
    }, 5000); // Check every 5 seconds

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
    reconnectCount: reconnectCountRef.current // New: track reconnection attempts
  };
}
