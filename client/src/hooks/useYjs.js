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

// FIX 3: Export function to clear instance cache on auth failure
export function clearYjsInstanceCache() {
  console.log('[useYjs] Clearing instance cache due to auth failure');
  instanceCache.forEach((cached) => {
    if (cached.provider) {
      cached.provider.destroy();
    }
    if (cached.indexeddbProvider) {
      cached.indexeddbProvider.destroy();
    }
  });
  instanceCache.clear();
}

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

  // FIX 2: Enhanced close event monitoring for auth issues
  provider.on('connection-close', (event) => {
    logPerf('WS_CLOSE_EVENT', { code: event.code, reason: event.reason });

    // WebSocket close codes:
    // - 4401, 4403: Custom auth/permission errors (if server implements them)
    // - 1008: Policy Violation (standard code often used for auth failures)
    // - 1006: Abnormal closure (can indicate upgrade failure)
    const authRelatedCodes = [1008, 1006, 4401, 4403];

    if (authRelatedCodes.includes(event.code)) {
      console.error(`❌ CONNECTION CLOSED (code ${event.code}) - Likely auth failure. Reason: ${event.reason || 'none'}`);
      logPerf('AUTH_CLOSE_DETECTED', { code: event.code, reason: event.reason });
      // Note: authError state is set in the useEffect handler below
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
  // FIX 1: Proactive Token Validation - Don't create WebSocket without valid token
  // This prevents auth failures at the source by not attempting connection without credentials
  if (!accessToken) {
    console.warn('[useYjs] No access token available, skipping WebSocket connection');
    // Return minimal structure with no provider - prevents connection attempts
    // The ydoc can still be used for offline work if needed
    return {
      ydoc: new Y.Doc(),
      provider: null,
      indexeddbProvider: null,
      accessToken: null
    };
  }

  // Include token in cache key to reconnect if token changes
  const cacheKey = docGuid;

  if (instanceCache.has(cacheKey)) {
    const cached = instanceCache.get(cacheKey);
    // If token changed, handle based on the type of change
    if (cached.accessToken !== accessToken) {
      const hadToken = !!cached.accessToken;
      const hasToken = !!accessToken;

      // Update cached token reference
      cached.accessToken = accessToken;

      // Case 1: Token went from something to null (logout/expiry)
      if (hadToken && !hasToken && cached.provider) {
        console.warn('[useYjs] Token cleared, disconnecting WebSocket');
        cached.provider.destroy();
        cached.provider = null;
        return cached;
      }

      // Case 2: Token went from null to something (login)
      // This shouldn't happen with current cache key logic, but handle it
      if (!hadToken && hasToken && !cached.provider) {
        console.log(`[useYjs] Token set, creating provider for ${docGuid}`);
        // Create new provider (fall through to creation logic below)
        const wsParams = { token: accessToken };
        cached.provider = new WebsocketProvider(WS_URL, docGuid, cached.ydoc, {
          connect: true,
          params: wsParams
        });
        setupProviderListeners(cached.provider, cached.ydoc, docGuid);
        return cached;
      }

      // Case 3: Token refreshed (both old and new are non-null)
      if (hadToken && hasToken) {
        // If provider is connected, keep it (token only used for initial handshake)
        // If provider is disconnected, recreate it with new token for reconnection
        if (cached.provider && cached.provider.wsconnected) {
          console.log('[useYjs] Token refreshed, keeping existing WebSocket connection');
          return cached;
        } else {
          console.log('[useYjs] Token refreshed while disconnected, recreating provider with new token');
          // Destroy old provider
          if (cached.provider) {
            cached.provider.destroy();
          }
          // Create new provider with new token
          const wsParams = { token: accessToken };
          cached.provider = new WebsocketProvider(WS_URL, docGuid, cached.ydoc, {
            connect: true,
            params: wsParams
          });
          setupProviderListeners(cached.provider, cached.ydoc, docGuid);
          return cached;
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
  const [reconnectCount, setReconnectCount] = useState(0); // Track reconnection attempts (useState for UI updates)
  const reconnectCountRef = useRef(0); // Internal ref for total reconnect count (manual + automatic)
  const autoFailureCountRef = useRef(0); // Separate counter for automatic connection failures only
  const instancesRef = useRef(null);
  const lastSyncTimeRef = useRef(Date.now());
  const lastForceReconnectRef = useRef(0); // For debouncing forceReconnect
  const [providerVersion, setProviderVersion] = useState(0); // Force re-render when provider changes

  // Get or create instances for this docGuid
  if (!instancesRef.current || instancesRef.current.docGuid !== docGuid) {
    const instances = getOrCreateInstances(docGuid, accessToken);
    instancesRef.current = { ...instances, docGuid };
  }

  // NOTE: Don't update instancesRef in render phase!
  // Token changes are handled in the useEffect below to ensure proper auth detection
  // and provider cleanup/recreation timing

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

  // Manual reconnection function with debouncing
  const forceReconnect = useCallback(() => {
    if (!provider) return;

    // Don't attempt reconnection if we don't have a valid token
    // This prevents futile reconnection attempts when auth has failed
    if (!accessToken) {
      console.log('[useYjs] forceReconnect skipped (no access token available)');
      return;
    }

    // Debounce: ignore calls within 300ms of last call
    const now = Date.now();
    if (now - lastForceReconnectRef.current < 300) {
      console.log('[useYjs] forceReconnect debounced (called too quickly)');
      return;
    }
    lastForceReconnectRef.current = now;

    console.log('[useYjs] Forcing reconnection...');
    reconnectCountRef.current += 1;
    setReconnectCount(reconnectCountRef.current);
    logPerf('FORCE_RECONNECT', { attempt: reconnectCountRef.current });
    provider.disconnect();
    setTimeout(() => {
      provider.connect();
    }, 100);
  }, [provider, accessToken]);

  // FIX 1 & FIX 4: Handle token becoming null (auth expired/failed)
  useEffect(() => {
    console.log('[useYjs] Token state changed:', {
      hasToken: !!accessToken,
      hasProvider: !!instancesRef.current?.provider,
      currentAuthError: authError,
      docGuid
    });

    if (accessToken === null && instancesRef.current?.provider) {
      console.warn('[useYjs] ⚠️ Token cleared while provider exists - AUTH FAILURE DETECTED');
      setAuthError(true);
      setConnectionState('disconnected');
    } else if (accessToken === null) {
      console.log('[useYjs] Token is null but no provider - likely initial load or already cleaned up');
    } else if (accessToken && authError) {
      // CRITICAL FIX: Clear auth error when token is restored
      // This prevents the "Session expired" banner from getting stuck when token refresh succeeds
      console.log('[useYjs] Token restored, clearing auth error and reconnecting');
      setAuthError(false);
      // Reset both counters on successful token restoration
      reconnectCountRef.current = 0;
      setReconnectCount(0);
      autoFailureCountRef.current = 0;

      // Update instances when token is restored (might create new provider)
      const instances = getOrCreateInstances(docGuid, accessToken);
      instancesRef.current = { ...instances, docGuid };
      // Force re-render so useEffect picks up the new provider and attaches event handlers
      setProviderVersion(v => v + 1);

      // Re-enable reconnection and attempt to connect
      if (instances.provider) {
        instances.provider.shouldConnect = true;
        if (!instances.provider.wsconnected) {
          console.log('[useYjs] Reconnecting WebSocket after auth restoration');
          instances.provider.connect();
        }
      }
    } else if (accessToken && instancesRef.current && instancesRef.current.accessToken !== accessToken) {
      // Token changed (refresh) while connected - update the provider reference
      console.log('[useYjs] Token refreshed, updating provider reference');
      const instances = getOrCreateInstances(docGuid, accessToken);
      instancesRef.current = { ...instances, docGuid };
      // Force re-render so useEffect picks up the new provider and attaches event handlers
      setProviderVersion(v => v + 1);
    }
  }, [accessToken, authError, docGuid]);

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
      // FIX 2: Enhanced auth error detection
      // Detect authentication/authorization failures from error messages
      if (error && error.message) {
        const errorMsg = error.message.toLowerCase();
        const hasAuthKeyword = errorMsg.includes('401') || errorMsg.includes('unauthorized') ||
                                errorMsg.includes('403') || errorMsg.includes('forbidden') ||
                                errorMsg.includes('auth');

        if (hasAuthKeyword) {
          console.error('❌ AUTHENTICATION FAILED - Your session may have expired.');
          logPerf('AUTH_ERROR_DETECTED', { error: error.message });
          setAuthError(true);
          // Prevent further reconnection attempts
          if (provider) {
            provider.shouldConnect = false;
          }
        }
      }

      // Track failed connection attempts
      // Increment both counters: total reconnects (for display) and automatic failures (for MAX_RETRIES)
      reconnectCountRef.current += 1;
      setReconnectCount(reconnectCountRef.current);
      autoFailureCountRef.current += 1;

      // If we've failed to connect automatically multiple times in a row, likely an auth issue
      // Note: Manual reconnects (forceReconnect) don't count toward this threshold
      const MAX_RETRIES_BEFORE_AUTH_ERROR = 5;
      if (autoFailureCountRef.current >= MAX_RETRIES_BEFORE_AUTH_ERROR) {
        console.error(`❌ CONNECTION FAILED after ${autoFailureCountRef.current} automatic failures - Likely auth issue`);
        logPerf('MAX_RETRIES_REACHED', { attempts: autoFailureCountRef.current });
        setAuthError(true);
        // Prevent further reconnection attempts
        if (provider) {
          provider.shouldConnect = false;
        }
      }
    };

    const handleConnectionClose = (event) => {
      // FIX 2: Detect auth failures from close codes
      // WebSocket close codes:
      // - 4401, 4403: Custom auth/permission errors
      // - 1008: Policy Violation (often used for auth failures)
      // - 1006: Abnormal closure (can indicate HTTP 401/403 during upgrade)
      const authRelatedCodes = [1008, 1006, 4401, 4403];

      if (authRelatedCodes.includes(event.code)) {
        console.error(`❌ CONNECTION REJECTED (code ${event.code}) - Authentication or authorization failed.`);
        logPerf('AUTH_CLOSE_DETECTED', { code: event.code, reason: event.reason });
        setAuthError(true);
        // Prevent further reconnection attempts
        if (provider) {
          provider.shouldConnect = false;
        }
      }
    };

    const handleSync = (isSynced) => {
      console.log('[useYjs] Sync event:', isSynced);
      setSynced(isSynced);
      if (isSynced) {
        lastSyncTimeRef.current = Date.now();
        // Reset both counters on successful sync
        reconnectCountRef.current = 0;
        setReconnectCount(0);
        autoFailureCountRef.current = 0;

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
        const clientId = awareness.clientID;
        console.log('[useYjs] Component unmounting, clearing awareness for client', clientId);
        // Clear user and cursor fields specifically (don't clear entire state)
        awareness.setLocalStateField('user', null);
        awareness.setLocalStateField('cursor', null);
      }
    };
  }, [awareness]);

  // CRITICAL: Clear awareness on page unload (refresh/close)
  // This prevents ghost users when page refreshes don't complete cleanup
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (awareness && typeof awareness.setLocalStateField === 'function') {
        const clientId = awareness.clientID;
        console.log('[useYjs] Page unloading, clearing awareness for client', clientId);
        // Synchronously clear awareness before page unloads
        awareness.setLocalStateField('user', null);
        awareness.setLocalStateField('cursor', null);
      }
      // Also disconnect provider to ensure WebSocket closes cleanly
      if (provider && typeof provider.disconnect === 'function') {
        console.log('[useYjs] Page unloading, disconnecting provider');
        provider.disconnect();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [awareness, provider]);

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
    reconnectCount, // Track reconnection attempts (triggers re-render on change)
    authError // New: track authentication errors
  };
}
