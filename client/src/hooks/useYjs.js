import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';

// WebSocket URL
const WS_URL = (() => {
  if (import.meta.env.VITE_WS_URL) {
    const url = import.meta.env.VITE_WS_URL;
    return url.endsWith('/') ? url : url + '/';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/s/`;
})();

// JWT expiry check
function isTokenExpired(token) {
  if (!token) return true;
  try {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)));
    return decoded.exp ? Date.now() >= decoded.exp * 1000 : false;
  } catch {
    return false;
  }
}

// Check for auth-related error
function isAuthError(error) {
  const msg = error?.message?.toLowerCase() || '';
  return msg.includes('401') || msg.includes('unauthorized') ||
         msg.includes('403') || msg.includes('forbidden') || msg.includes('auth');
}

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
  // Store user in ref so callbacks always have current value
  const userRef = useRef(user);
  userRef.current = user;

  const { ydoc, indexeddbProvider } = useMemo(() => getOrCreateDoc(docGuid), [docGuid]);

  // ============================================================================
  // PROVIDER LIFECYCLE
  // ============================================================================
  useEffect(() => {
    if (!accessToken || isTokenExpired(accessToken)) {
      setConnectionState('disconnected');
      setAuthError(true);
      return;
    }

    setAuthError(false);
    setConnectionState('connecting');
    setReconnectCount(0);

    let isMounted = true;
    const newProvider = new WebsocketProvider(WS_URL, docGuid, ydoc, {
      connect: false,
      // Token is sent via HttpOnly cookie, not URL params
    });
    setProvider(newProvider);

    let failureCount = 0;
    const MAX_FAILURES = 2;

    // Helper: handle connection failure
    const handleFailure = (isAuthFailure) => {
      if (isAuthFailure) {
        setAuthError(true);
        newProvider.shouldConnect = false;
        return;
      }
      failureCount++;
      setReconnectCount(c => c + 1);
      if (failureCount >= MAX_FAILURES) {
        setAuthError(true);
        newProvider.shouldConnect = false;
      }
    };

    // Single point of awareness broadcasting - ONLY on connected
    // This ensures awareness is set AFTER connection is established
    const handleStatus = ({ status }) => {
      setConnectionState(status);
      if (status === 'connected') {
        setAuthError(false);
        failureCount = 0;
        // Set awareness fresh on every connect/reconnect
        const currentUser = userRef.current;
        if (currentUser) {
          newProvider.awareness.setLocalStateField('user', currentUser);
        }
      }
    };

    const handleSync = (isSynced) => {
      setSynced(isSynced);
      if (isSynced) {
        failureCount = 0;
        setReconnectCount(0);
        const meta = ydoc.getMap('meta');
        if (meta.get('title') === undefined) meta.set('title', 'Untitled Document');
      }
    };

    const handleError = (error) => handleFailure(isAuthError(error));
    const handleClose = ({ code }) => {
      // Explicit auth codes are immediate auth failures
      if (code === 4401 || code === 4403) {
        handleFailure(true);
      } else {
        // Other close codes count toward failure threshold
        handleFailure(false);
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
    newProvider.on('connection-error', handleError);
    newProvider.on('connection-close', handleClose);
    newProvider.awareness.on('change', handleAwarenessChange);

    // Delay connection slightly to avoid StrictMode double-connect errors
    // Awareness is set in handleStatus after connection is established
    const connectTimeout = setTimeout(() => {
      if (!isMounted) return;
      newProvider.connect();
    }, 0);

    return () => {
      isMounted = false;
      clearTimeout(connectTimeout);
      newProvider.off('status', handleStatus);
      newProvider.off('sync', handleSync);
      newProvider.off('connection-error', handleError);
      newProvider.off('connection-close', handleClose);
      newProvider.awareness.off('change', handleAwarenessChange);
      // Don't set user/cursor to null - this broadcasts zombie states
      // Instead, just destroy the provider which will remove awareness properly
      newProvider.destroy();
      setProvider(null);
    };
  }, [docGuid, accessToken, ydoc, user?.name, user?.color]);

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
    if (!provider || !accessToken) return;
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
