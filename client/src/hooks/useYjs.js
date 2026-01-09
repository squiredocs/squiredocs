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

    const newProvider = new WebsocketProvider(WS_URL, docGuid, ydoc, {
      connect: false,
      params: { token: accessToken },
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

    // Helper: rebroadcast awareness
    const rebroadcastAwareness = () => {
      const state = newProvider.awareness.getLocalState();
      if (state?.user) newProvider.awareness.setLocalStateField('user', state.user);
      if (state?.cursor) newProvider.awareness.setLocalStateField('cursor', state.cursor);
    };

    const handleStatus = ({ status }) => {
      setConnectionState(status);
      if (status === 'connected') {
        setAuthError(false);
        failureCount = 0;
        rebroadcastAwareness();
      }
    };

    const handleSync = (isSynced) => {
      setSynced(isSynced);
      if (isSynced) {
        failureCount = 0;
        setReconnectCount(0);
        const meta = ydoc.getMap('meta');
        if (meta.get('title') === undefined) meta.set('title', 'Untitled Document');
        rebroadcastAwareness();
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
      const userList = Array.from(newProvider.awareness.getStates().values())
        .filter(s => s.user)
        .map(s => ({ ...s.user, id: s.user.id }));
      setUsers(userList);
    };

    // Attach listeners
    newProvider.on('status', handleStatus);
    newProvider.on('sync', handleSync);
    newProvider.on('connection-error', handleError);
    newProvider.on('connection-close', handleClose);
    newProvider.awareness.on('change', handleAwarenessChange);

    if (user) newProvider.awareness.setLocalStateField('user', user);
    newProvider.connect();

    return () => {
      newProvider.off('status', handleStatus);
      newProvider.off('sync', handleSync);
      newProvider.off('connection-error', handleError);
      newProvider.off('connection-close', handleClose);
      newProvider.awareness.off('change', handleAwarenessChange);
      newProvider.awareness.setLocalStateField('user', null);
      newProvider.awareness.setLocalStateField('cursor', null);
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
      if (document.hidden || !provider.wsconnected) return;
      if (Date.now() - lastSyncTime > 30000) {
        provider.disconnect();
        setTimeout(() => provider.connect(), 100);
      } else {
        const state = provider.awareness.getLocalState();
        if (state?.user) provider.awareness.setLocalStateField('user', state.user);
      }
    };

    const handleUnload = () => {
      provider.awareness.setLocalStateField('user', null);
      provider.awareness.setLocalStateField('cursor', null);
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
