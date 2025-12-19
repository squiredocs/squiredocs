# WebSocket & Authentication Architecture Analysis

## Problem Statement

When users have multiple tabs open and leave their laptop idle overnight, auth tokens expire. Upon returning:
1. Tabs get stuck in "Connecting..." state indefinitely
2. Users aren't redirected to login to reauthenticate
3. Even new tabs have trouble connecting
4. No error message indicates the session has expired

---

## Current Architecture Overview

### Components Involved

| Component | File | Role |
|-----------|------|------|
| AuthContext | `client/src/contexts/AuthContext.jsx` | Manages auth state, token refresh, axios interceptors |
| useYjs | `client/src/hooks/useYjs.js` | WebSocket connection, Yjs document management |
| EditorView | `client/src/components/EditorView.jsx` | Displays connection state and auth error banners |
| Server WS Auth | `server/index.js:911-944` | Validates JWT tokens on WebSocket upgrade |
| Permissions | `server/permissions.js` | Token extraction and verification |

### Token Configuration

| Token Type | Storage | Expiry | Purpose |
|------------|---------|--------|---------|
| Access Token | In-memory (React state) | 15 minutes | API and WebSocket auth |
| Refresh Token | HTTP-only cookie | 7 days | Silent token refresh |

---

## Root Causes Identified

### 1. No Token Validation Before WebSocket Connect

**Location:** `useYjs.js:142-274`

When `useYjs` is called, it creates/retrieves a WebSocket provider with whatever `accessToken` is passed. If the token is null (because refresh failed), the WebSocket still attempts to connect.

```javascript
// useYjs.js:204-208
const wsParams = accessToken ? { token: accessToken } : {};
const provider = new WebsocketProvider(WS_URL, docGuid, ydoc, {
  connect: false,  // Starts disconnected
  params: wsParams // Empty params if no token!
});
```

**Problem:** When `accessToken` is null, the WebSocket connects without authentication, receives a 401, but the error detection is fragile.

### 2. Fragile Auth Error Detection

**Location:** `useYjs.js:354-365` and `useYjs.js:368-375`

The code attempts to detect auth failures by pattern-matching error messages:

```javascript
// useYjs.js:354-365
const handleConnectionError = (error) => {
  if (error && error.message) {
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('401') || errorMsg.includes('unauthorized') ||
        errorMsg.includes('403') || errorMsg.includes('forbidden') ||
        errorMsg.includes('auth')) {
      setAuthError(true);
    }
  }
};
```

**Problems:**
- The y-websocket library wraps errors, so messages may not contain "401"
- WebSocket upgrade failures often produce generic messages like "connection failed"
- The server sends `HTTP/1.1 401 Unauthorized` but this may not be parsed into the error message

### 3. Instance Cache Doesn't Account for Auth State

**Location:** `useYjs.js:36-46`, `useYjs.js:142-180`

The `instanceCache` maps `docGuid` to Yjs instances. When token changes, it recreates the provider:

```javascript
// useYjs.js:146-178
if (instanceCache.has(cacheKey)) {
  const cached = instanceCache.get(cacheKey);
  if (cached.accessToken !== accessToken && cached.provider) {
    // Recreates provider with new token
    cached.provider.destroy();
    cached.provider = new WebsocketProvider(...);
  }
  return cached;
}
```

**Problem:** This logic runs, but if `accessToken` is null (refresh failed), the new provider is created with no token and will fail auth. The cache isn't cleared on auth failure.

### 4. No Cross-Component Auth Failure Propagation

**Location:** `AuthContext.jsx:184-192`

When token refresh fails, AuthContext sets state to null:

```javascript
// AuthContext.jsx:184-192
catch (refreshError) {
  isRefreshing.current = false;
  notifyRefreshSubscribers(null);
  setAccessToken(null);
  setUser(null);
  return Promise.reject(error);
}
```

**Problem:** Existing WebSocket connections don't know about this. There's no event/callback to notify `useYjs` that auth has failed and connections should stop retrying.

### 5. IndexedDB Timing Creates Race Conditions

**Location:** `useYjs.js:217-269`

The WebSocket connection is delayed until IndexedDB syncs, with a 500ms fallback timeout:

```javascript
// useYjs.js:239-252
indexeddbProvider.once('synced', () => {
  provider.connect();
});

setTimeout(() => {
  if (!provider.wsconnected && !provider.shouldConnect) {
    provider.connect();
  }
}, 500);
```

**Problem:** If IndexedDB takes longer than 500ms, the provider might connect with a stale/expired token that was valid when the hook was first called but expired by the time the connection is made.

### 6. Silent Recovery Failure

When auth refresh fails on page load:

```javascript
// AuthContext.jsx:248-265
try {
  const newToken = await refreshAccessToken();
  await fetchUser(newToken);
} catch (refreshError) {
  // Just logs, no error state set
  console.log('No existing session, user needs to login');
}
```

**Problem:** No error flag is set. The `isAuthenticated` check in `App.jsx` relies on `user && accessToken` being null, but if EditorView is already mounted, it continues trying to use stale WebSocket connections.

---

## Sequence Diagram: The Bug in Action

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Timeline: User closes laptop overnight, refresh token expires               │
└─────────────────────────────────────────────────────────────────────────────┘

T=0: User working on doc, WebSocket connected
     ├─ accessToken: "eyJhbGc..." (15min expiry)
     ├─ refreshToken: cookie (7-day expiry)
     └─ instanceCache: { docGuid -> Provider (connected) }

T=8h: Laptop wakes, tabs try to reconnect
     ├─ Access tokens expired (> 15 min)
     └─ Refresh token MAY be expired (if > 7 days)

T+1s: AuthContext.initAuth() runs
     ├─ Calls refreshAccessToken()
     ├─ Server returns 401 (refresh token invalid/expired)
     ├─ Sets accessToken = null, user = null
     └─ EditorView already mounted, calls useYjs(docGuid, null)

T+2s: useYjs processes null token
     ├─ getOrCreateInstances(docGuid, null)
     ├─ Finds cached provider, token changed
     ├─ Destroys old provider, creates new
     └─ new WebsocketProvider with params: {} (no token!)

T+3s: WebSocket upgrade request sent
     ├─ Server: GET /s/{docId} (no token)
     ├─ permissions.extractUser({ queryToken: undefined }) → null
     └─ Server sends: "HTTP/1.1 401 Unauthorized"

T+4s: Client receives 401
     ├─ Error message wrapped by y-websocket: "WebSocket connection failed"
     ├─ Regex check: "failed".includes("401") → FALSE
     ├─ authError NOT SET
     └─ connectionState remains "connecting"

T+5s: UI shows "Connecting..." forever
     ├─ authError = false → no error banner
     ├─ connectionState = "connecting" → shows "Connecting..."
     └─ User stuck with no indication of what's wrong
```

---

## Impact Assessment

| Scenario | Severity | Affected Users |
|----------|----------|----------------|
| Laptop left overnight (access token expired) | High | All users with stale tabs |
| Refresh token expired (> 7 days) | Critical | Users returning after vacation |
| Multiple tabs with same document | Medium | Power users |
| New tabs opened after token expires | High | All affected users |

---

## Recommended Fixes

### Fix 1: Proactive Token Validation in useYjs

**Before connecting**, validate that we have a token. If not, don't attempt connection.

```javascript
// In useYjs.js, modify getOrCreateInstances
function getOrCreateInstances(docGuid, accessToken) {
  // NEW: Don't create WebSocket provider without valid token
  if (!accessToken) {
    console.warn('[useYjs] No access token available, skipping WebSocket connection');
    return { ydoc: new Y.Doc(), provider: null, indexeddbProvider: null, accessToken: null };
  }
  // ... rest of function
}
```

### Fix 2: Reliable Auth Error Detection via Close Codes

Instead of parsing error messages, use WebSocket close codes:

```javascript
// In useYjs.js, enhance handleConnectionClose
const handleConnectionClose = (event) => {
  // 4401 = Custom auth failure code (set by server)
  // 4403 = Custom forbidden code
  // 1008 = Policy violation (often auth)
  if (event.code === 4401 || event.code === 4403 || event.code === 1008) {
    setAuthError(true);
    // Stop reconnection attempts
    provider.shouldConnect = false;
  }
};
```

**Server change** - use custom close code:

```javascript
// In server/index.js, instead of socket.write
ws.close(4401, 'Authentication required');
```

### Fix 3: Clear Instance Cache on Auth Failure

Add a function to clear cached instances when auth fails:

```javascript
// In useYjs.js, export a cleanup function
export function clearYjsInstanceCache() {
  instanceCache.forEach((cached) => {
    cached.provider?.destroy();
    cached.indexeddbProvider?.destroy();
  });
  instanceCache.clear();
}

// In AuthContext.jsx, call when logout or auth fails
import { clearYjsInstanceCache } from '../hooks/useYjs';

const logout = useCallback(async () => {
  clearYjsInstanceCache(); // Clear WebSocket connections
  setAccessToken(null);
  setUser(null);
  // ...
});
```

### Fix 4: Add Auth State Change Listener in useYjs

Subscribe to auth changes and handle them:

```javascript
// In useYjs.js, add effect to handle token becoming null
useEffect(() => {
  if (accessToken === null && instancesRef.current?.provider) {
    console.log('[useYjs] Token cleared, disconnecting WebSocket');
    instancesRef.current.provider.disconnect();
    setAuthError(true);
  }
}, [accessToken]);
```

### Fix 5: Refresh Token on Tab Focus

Add visibility change handler to proactively refresh tokens:

```javascript
// In AuthContext.jsx, add visibility change handler
useEffect(() => {
  const handleVisibilityChange = async () => {
    if (document.visibilityState === 'visible' && !loading) {
      // Tab became visible - try to refresh token
      try {
        const newToken = await refreshAccessToken();
        if (newToken) {
          await fetchUser(newToken);
        }
      } catch (e) {
        // Refresh failed - user needs to login
        setAccessToken(null);
        setUser(null);
      }
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
}, [loading, refreshAccessToken, fetchUser]);
```

### Fix 6: Add "Session Expired" Redirect

When auth fails, redirect to login instead of showing "Connecting...":

```javascript
// In EditorView.jsx or App.jsx
useEffect(() => {
  if (authError && !isAuthenticated) {
    // Redirect to login with return URL
    navigate('/login', { state: { returnTo: location.pathname } });
  }
}, [authError, isAuthenticated, navigate, location]);
```

### Fix 7: Exponential Backoff with Max Attempts

Limit reconnection attempts to prevent infinite loops:

```javascript
// In useYjs.js, add max attempts
const MAX_RECONNECT_ATTEMPTS = 5;

const handleConnectionError = (error) => {
  reconnectCountRef.current += 1;

  if (reconnectCountRef.current >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[useYjs] Max reconnection attempts reached');
    provider.shouldConnect = false;
    setAuthError(true); // Assume auth issue after multiple failures
  }
};
```

---

## Recommended Architecture Changes

### Current Flow (Problematic)
```
AuthContext → accessToken → useYjs → WebsocketProvider
                                          ↓
                              (fails silently, retries forever)
```

### Proposed Flow (Fixed)
```
AuthContext ─────────────────────────────────────────┐
     │                                               │
     ├─→ accessToken → useYjs → WebsocketProvider    │
     │                              │                │
     │                              ├─→ Success ─────┤
     │                              │                │
     │                              └─→ 4401 close ──┤
     │                                               │
     └─→ onAuthFailure callback ←────────────────────┘
                    │
                    └─→ clearYjsInstanceCache()
                    └─→ redirect to /login
```

### Key Principles

1. **Fail fast**: Don't attempt WebSocket connection without valid token
2. **Fail clearly**: Use specific close codes, not error message parsing
3. **Fail once**: Clear caches and stop retrying on auth failure
4. **Recover gracefully**: Proactively refresh on tab focus
5. **Inform user**: Show specific "Session expired" message with login button

---

## Implementation Priority

| Priority | Fix | Effort | Impact | Rationale |
|----------|-----|--------|--------|-----------|
| P0 | Fix 6: Session expired redirect | Low | High | Highest user impact - turns confusing "Connecting..." into actionable login page |
| P0 | Fix 2: Close codes for auth errors | Medium | High | Makes Fix 6 work reliably by ensuring `authError` is set |
| P0 | Fix 1: Token validation before connect | Low | High | Prevents the problem at source - don't attempt WebSocket without valid token |
| P1 | Fix 3: Clear instance cache | Low | Medium | Cleanup stale connections, prevents edge cases with multiple tabs |
| P2 | Fix 5: Refresh on tab focus | Medium | Medium | Proactive - avoids the problem entirely by refreshing before expiry |
| P2 | Fix 4: Auth state listener | Medium | Medium | Defense in depth - handles edge cases where token changes mid-session |
| P3 | Fix 7: Exponential backoff | Low | Low | Nice to have - prevents excessive reconnection attempts |

**Note:** Fix 6 is prioritized first despite depending on Fix 2 because:
1. It directly addresses the user-facing symptom (stuck on "Connecting...")
2. It provides partial value even with current imperfect detection
3. It's trivial to implement and can ship alongside Fix 2

---

## Testing Checklist

- [ ] Token expires while tab is open → shows "Session expired", login button works
- [ ] Refresh token expires → redirects to login
- [ ] Multiple tabs open, token expires → all tabs show error or redirect
- [ ] New tab opened after token expires → shows login, not "Connecting..."
- [ ] Tab focus after long idle → silently refreshes token if valid
- [ ] Tab focus after refresh token expires → redirects to login
- [ ] Server returns 4401 → client detects auth error immediately
