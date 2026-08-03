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

// ============================================================================
// LOCAL-STATE GATE (feature 047, NF-1)
// ============================================================================
/**
 * How long we wait for IndexedDB to finish loading before connecting anyway.
 *
 * The gate must never be able to hold the socket shut: `whenSynced` is created
 * by y-indexeddb as a bare `promise.create(resolve => this.on('synced', ...))`,
 * so if `openDB` rejects or hangs — private browsing, exhausted quota, another
 * tab blocking a version change — it NEVER settles. Racing it against a timer
 * is what makes the gate fail OPEN rather than deadlock the editor.
 */
const LOCAL_LOAD_TIMEOUT_MS = 3000;

/**
 * Resolve once the cached IndexedDB state has been applied to the Y.Doc — or
 * once we have waited long enough that we would rather connect without it.
 *
 * ── WHY THE SOCKET WAITS ON INDEXEDDB (NF-1) ────────────────────────────────
 * `IndexeddbPersistence` and `WebsocketProvider` were started independently,
 * with NO ordering between them. That is fine while the two agree, and wrong in
 * exactly the case the update log has to survive: a pod dies in the
 * publish-before-commit window, so user U's browser holds content authored by V
 * that the server never committed. U reopens the doc. If WS sync completes
 * FIRST, y-indexeddb then applies the cached state into an already-synced doc,
 * those server-missing structs are newly integrated, and they fire a normal
 * `update` whose origin is the IDB provider. y-websocket relays any update whose
 * origin is not itself (`origin !== this`), so V's content reaches the server as
 * an ordinary SYNC_UPDATE frame — not a SYNC_STEP2 frame. The durable row is
 * stamped (U, null) with `via_sync` NULL, so every surface confidently credits U
 * for V's words, and worse, that row is admissible evidence: it binds V's client
 * identity to U, so later legitimate resolutions go confidently wrong too.
 *
 * Waiting means the cached content is instead part of the state vector U sends
 * in the handshake, so it comes back through the SYNC_STEP2 channel, which is
 * marked `via_sync` and resolved forensically (feature 045) instead of believed.
 *
 * First paint is not the cost it looks like: for a returning user the content
 * being waited on IS the paint, and for a new document the store is empty and
 * resolves in a few milliseconds.
 *
 * RESIDUAL: when the timeout fires open, the original race is back for that
 * load. Connecting late is strictly worse than mis-attributing rarely — an
 * editor that will not open is a total failure — so the gate yields.
 *
 * @param {object|null} idbProvider
 * @returns {Promise<void>}
 */
function whenLocalStateLoaded(idbProvider) {
  const pending = idbProvider?.whenSynced;
  // No IndexedDB at all, a constructor that threw, or a provider without the
  // promise: there is no cached state that could arrive late, so nothing to wait
  // for. Resolving synchronously here also keeps the gate free for these cases
  // rather than charging them the timeout.
  if (!pending || typeof pending.then !== 'function') return Promise.resolve();

  let timer = null;
  return Promise.race([
    // y-indexeddb never rejects this, but a swallowed rejection must not become
    // an unhandled rejection that fails the load.
    Promise.resolve(pending).catch(() => {}),
    new Promise((resolve) => { timer = setTimeout(resolve, LOCAL_LOAD_TIMEOUT_MS); }),
  ]).then(() => { if (timer) clearTimeout(timer); });
}

function getOrCreateDoc(docGuid) {
  if (docCache.has(docGuid)) return docCache.get(docGuid);

  // Set the Y.Doc's guid to the real document GUID so downstream consumers that
  // read `ydoc.guid` — notably the 021 render-skip beacon — report the actual
  // document instead of a random per-tab UUID (review MEDIUM-3). IndexeddbPersistence
  // keys off the separate `docGuid` string argument below, not ydoc.guid, so this
  // has no persistence/cache side effect.
  const ydoc = new Y.Doc({ guid: docGuid });
  const cached = { ydoc, indexeddbProvider: null, localLoaded: null };
  docCache.set(docGuid, cached);

  // Initialize IndexedDB asynchronously (best-effort)
  if (typeof indexedDB !== 'undefined') {
    try {
      cached.indexeddbProvider = new IndexeddbPersistence(docGuid, ydoc);
    } catch (e) {
      console.warn('[useYjs] IndexedDB init failed:', e.message);
    }
  }

  // Started ONCE per document, here rather than in the effect: the timeout must
  // run from when the store was opened, and a remount must not restart the wait
  // (by then the state is already loaded and this promise is already resolved).
  cached.localLoaded = whenLocalStateLoaded(cached.indexeddbProvider);

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
  const [docTitle, setDocTitleState] = useState('');
  const [authError, setAuthError] = useState(false);
  const [reconnectCount, setReconnectCount] = useState(0);
  const [provider, setProvider] = useState(null);
  const lastForceReconnectRef = useRef(0);
  // Store current values in refs so callbacks always have them
  const userRef = useRef(user);
  userRef.current = user;
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  const { ydoc, indexeddbProvider, localLoaded } = useMemo(() => getOrCreateDoc(docGuid), [docGuid]);

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
        // NF-1: never open the socket before the cached IndexedDB state has been
        // applied, so anything the server is missing goes out through the
        // handshake (flagged `via_sync`) instead of as an unflagged relay
        // attributed to whoever happened to open the tab. See
        // whenLocalStateLoaded.
        localLoaded.then(() => {
          if (isMounted) newProvider.connect();
        });
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
  }, [docGuid, ydoc, localLoaded]);

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
      // Gated for the SAME reason as the initial connect (NF-1), and not only
      // as belt-and-braces: while the initial connect is still waiting on
      // IndexedDB the provider is not connected and `shouldConnect` is false, so
      // this branch is live and would otherwise open the socket first and
      // reintroduce the race it was gated to prevent. On a genuine mid-session
      // token refresh the promise is long since resolved, so this costs a
      // microtask.
      // `shouldConnect` is the liveness tombstone: destroy() calls disconnect(),
      // which clears it. Without this check a doc closed inside the gate window
      // (up to 3 s in private browsing, where whenSynced never settles) would
      // resolve after cleanup and open a socket nobody owns — no listeners, and
      // in an SPA it survives until unload, pinning the doc in the server
      // registry. Same reason the initial connect checks `isMounted`.
      localLoaded.then(() => {
        if (provider.shouldConnect) provider.connect();
      });
    }
  }, [accessToken, provider, localLoaded]);

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
      // Convert undefined/null to empty string for controlled input
      setDocTitleState(title ?? '');
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
    // Gated like every other connect (NF-1). In practice this fires long after
    // the local state loaded, so it is a microtask; gating it anyway means NO
    // path in this hook can open the socket ahead of IndexedDB.
    setTimeout(() => localLoaded.then(() => {
      if (provider.shouldConnect) provider.connect();
    }), 100);
  }, [provider, accessToken, localLoaded]);

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
