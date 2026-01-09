import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { isTokenExpired } from '../utils/jwt';

// WebSocket URL
const WS_URL = (() => {
  if (import.meta.env.VITE_WS_URL) {
    const url = import.meta.env.VITE_WS_URL;
    return url.endsWith('/') ? url : url + '/';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/s/`;
})();

// ============================================================================
// DOCUMENT CACHE - ydoc + IndexedDB persistence (stable, long-lived)
// ============================================================================
const docCache = new Map();

// For testing
if (typeof global !== 'undefined' && global.__TEST_RESET_YJS_SINGLETONS__) {
  docCache.clear();
  delete global.__TEST_RESET_YJS_SINGLETONS__;
}

function getOrCreateDoc(docGuid) {
  if (docCache.has(docGuid)) return docCache.get(docGuid);

  const ydoc = new Y.Doc();
  const cached = { ydoc, indexeddbProvider: null };
  docCache.set(docGuid, cached);

  // Initialize IndexedDB asynchronously (best-effort)
  if (typeof indexedDB !== 'undefined') {
    try {
      cached.indexeddbProvider = new IndexeddbPersistence(docGuid, ydoc);
    } catch (e) {
      console.warn('[useYjs] IndexedDB init failed:', e.message);
    }
  }

  return cached;
}

export function clearYjsInstanceCache() {
  docCache.forEach(({ indexeddbProvider }) => indexeddbProvider?.destroy());
  docCache.clear();
}

// ============================================================================
// MAIN HOOK
// ============================================================================
export function useYjs(docGuid, accessToken, user = null) {
  const [connectionState, setConnectionState] = useState('connecting');
  const [synced, setSynced] = useState(false);
  const [users, setUsers] = useState([]);
  const [docTitle, setDocTitleState] = useState('Untitled Document');
  const [authError, setAuthError] = useState(false);
  const [reconnectCount, setReconnectCount] = useState(0);
  const [provider, setProvider] = useState(null);
  const lastForceReconnectRef = useRef(0);
  // Store current values in refs so callbacks always have them
  const userRef = useRef(user);
  userRef.current = user;
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  const { ydoc, indexeddbProvider } = useMemo(() => getOrCreateDoc(docGuid), [docGuid]);

  // ============================================================================
  // PROVIDER LIFECYCLE - stable per docGuid, doesn't recreate on token refresh
  // ============================================================================
  useEffect(() => {
    let isMounted = true;
    const newProvider = new WebsocketProvider(WS_URL, docGuid, ydoc, {
      connect: false,
      // Token is sent via HttpOnly cookie, not URL params
    });
    setProvider(newProvider);

    const handleStatus = ({ status }) => {
      setConnectionState(status);
      if (status === 'connected') {
        setAuthError(false);
        setReconnectCount(0);
        // Rebroadcast all awareness on every connect/reconnect
        const currentUser = userRef.current;
        if (currentUser) {
          newProvider.awareness.setLocalStateField('user', currentUser);
        }
        // Also rebroadcast cursor if present (preserved across reconnects)
        const localState = newProvider.awareness.getLocalState();
        if (localState?.cursor) {
          newProvider.awareness.setLocalStateField('cursor', localState.cursor);
        }
      } else if (status === 'disconnected') {
        setReconnectCount(c => c + 1);
      }
    };

    const handleSync = (isSynced) => {
      setSynced(isSynced);
      if (isSynced) {
        const meta = ydoc.getMap('meta');
        if (meta.get('title') === undefined) meta.set('title', 'Untitled Document');
      }
    };

    // Handle auth failures - both WebSocket close codes AND HTTP upgrade failures
    // When connection fails and token is expired, stop retrying - token effect will reconnect
    const handleAuthFailure = () => {
      if (isTokenExpired(accessTokenRef.current)) {
        console.log('[useYjs] Connection failed with expired token, stopping retries');
        setAuthError(true);
        newProvider.shouldConnect = false;
        newProvider.disconnect(); // Cancel any pending reconnect timers
      }
    };

    const handleClose = ({ code }) => {
      // Explicit auth close codes always trigger auth error
      if (code === 4401 || code === 4403) {
        setAuthError(true);
        newProvider.shouldConnect = false;
      } else {
        // Other close codes - check if token expired
        handleAuthFailure();
      }
    };

    // HTTP 401 on upgrade doesn't produce a WebSocket close code - it triggers connection-error
    const handleConnectionError = () => {
      handleAuthFailure();
    };

    const handleAwarenessChange = () => {
      const states = newProvider.awareness.getStates();
      const userList = Array.from(states.entries())
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

    // Attach listeners
    newProvider.on('status', handleStatus);
    newProvider.on('sync', handleSync);
    newProvider.on('connection-close', handleClose);
    newProvider.on('connection-error', handleConnectionError);
    newProvider.awareness.on('change', handleAwarenessChange);

    // Delay connection slightly to avoid StrictMode double-connect errors
    const connectTimeout = setTimeout(() => {
      if (!isMounted) return;
      // Only connect if we have a valid token
      if (accessTokenRef.current && !isTokenExpired(accessTokenRef.current)) {
        newProvider.connect();
      } else {
        setConnectionState('disconnected');
        setAuthError(true);
      }
    }, 0);

    return () => {
      isMounted = false;
      clearTimeout(connectTimeout);
      newProvider.off('status', handleStatus);
      newProvider.off('sync', handleSync);
      newProvider.off('connection-close', handleClose);
      newProvider.off('connection-error', handleConnectionError);
      newProvider.awareness.off('change', handleAwarenessChange);
      newProvider.destroy();
      setProvider(null);
    };
  }, [docGuid, ydoc]);

  // Handle token changes - server validates token on each message and closes with 4401 if expired
  // Client just needs to: disconnect if token invalid, reconnect if token valid and disconnected
  useEffect(() => {
    if (!provider) return;

    const tokenValid = accessToken && !isTokenExpired(accessToken);

    if (!tokenValid) {
      // Token invalid/expired - disconnect proactively (server would reject anyway)
      setAuthError(true);
      setConnectionState('disconnected');
      provider.shouldConnect = false;
      provider.disconnect();
    } else if (!provider.wsconnected && !provider.shouldConnect) {
      // Have valid token but disconnected - reconnect
      setAuthError(false);
      setReconnectCount(0);
      provider.shouldConnect = true;
      provider.connect();
    }
  }, [accessToken, provider]);

  // Update awareness when user changes (without recreating provider)
  useEffect(() => {
    if (!provider?.wsconnected || !user) return;
    provider.awareness.setLocalStateField('user', user);
  }, [provider, user?.name, user?.color]);

  // ============================================================================
  // TITLE SYNC
  // ============================================================================
  useEffect(() => {
    if (!ydoc) return;
    const meta = ydoc.getMap('meta');
    const update = () => {
      const title = meta.get('title');
      if (title !== undefined) setDocTitleState(title);
    };
    update();
    meta.observe(update);
    return () => meta.unobserve(update);
  }, [ydoc, synced]);

  // ============================================================================
  // BROWSER EVENTS - visibility change + beforeunload
  // ============================================================================
  useEffect(() => {
    if (!provider) return;

    // Rebroadcast awareness when tab becomes visible
    // Server handles token expiry validation, so we don't need to check staleness here
    const handleVisibility = () => {
      if (document.hidden || !provider.wsconnected) return;

      const currentUser = userRef.current;
      if (currentUser) {
        provider.awareness.setLocalStateField('user', currentUser);
      }
      // Also rebroadcast cursor if present
      const state = provider.awareness.getLocalState();
      if (state?.cursor) {
        provider.awareness.setLocalStateField('cursor', state.cursor);
      }
    };

    const handleUnload = () => {
      // Just disconnect - don't set null states that create zombies
      // y-websocket will handle awareness cleanup on disconnect
      provider.disconnect();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, [provider]);

  // ============================================================================
  // ACTIONS
  // ============================================================================
  const setDocTitle = useCallback((title) => ydoc?.getMap('meta').set('title', title), [ydoc]);

  const forceReconnect = useCallback(() => {
    if (!provider || !accessToken || isTokenExpired(accessToken)) return;
    // Debounce: ignore calls within 300ms
    const now = Date.now();
    if (now - lastForceReconnectRef.current < 300) return;
    lastForceReconnectRef.current = now;
    // Reset error state and allow reconnection
    setAuthError(false);
    provider.shouldConnect = true;
    setReconnectCount(c => c + 1);
    provider.disconnect();
    setTimeout(() => provider.connect(), 100);
  }, [provider, accessToken]);

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
