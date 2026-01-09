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
  // Store user and token in refs so callbacks always have current values
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
        // Set awareness fresh on every connect/reconnect
        const currentUser = userRef.current;
        if (currentUser) {
          newProvider.awareness.setLocalStateField('user', currentUser);
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

    // Only set authError for explicit auth failures - let y-websocket retry otherwise
    const handleClose = ({ code }) => {
      if (code === 4401 || code === 4403) {
        setAuthError(true);
        newProvider.shouldConnect = false;
      }
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
      newProvider.awareness.off('change', handleAwarenessChange);
      newProvider.destroy();
      setProvider(null);
    };
  }, [docGuid, ydoc]);

  // Handle token changes - disconnect on invalid, reconnect on valid + disconnected
  useEffect(() => {
    if (!provider) return;

    if (!accessToken || isTokenExpired(accessToken)) {
      // Token invalid - disconnect and set auth error
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

    let lastSyncTime = Date.now();
    const syncHandler = (isSynced) => { if (isSynced) lastSyncTime = Date.now(); };
    provider.on('sync', syncHandler);

    const handleVisibility = () => {
      if (document.hidden) return;

      // If connection is stale, reconnect (awareness will be set on reconnect)
      if (provider.wsconnected && Date.now() - lastSyncTime > 30000) {
        // Don't try to reconnect with an expired token - it will fail with 401
        if (isTokenExpired(accessTokenRef.current)) {
          console.log('[useYjs] Stale connection but token expired, setting authError');
          setAuthError(true);
          provider.shouldConnect = false;
          provider.disconnect();
          return;
        }
        console.log('[useYjs] Stale connection, reconnecting');
        provider.disconnect();
        setTimeout(() => provider.connect(), 100);
        return;
      }

      // Rebroadcast awareness when tab becomes visible (only if connected)
      if (provider.wsconnected) {
        const currentUser = userRef.current;
        if (currentUser) {
          provider.awareness.setLocalStateField('user', currentUser);
        }
        // Also rebroadcast cursor if present
        const state = provider.awareness.getLocalState();
        if (state?.cursor) {
          provider.awareness.setLocalStateField('cursor', state.cursor);
        }
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
      provider.off('sync', syncHandler);
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
