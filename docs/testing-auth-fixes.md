# Testing Auth Fixes - Step-by-Step Guide

This guide explains how to test the P0 authentication fixes that prevent users from getting stuck in "Connecting..." state when their session expires.

## What Was Fixed

1. **Fix 1**: Token validation before WebSocket connect (prevents connection without valid token)
2. **Fix 2**: Improved auth error detection (detects auth failures reliably)
3. **Fix 3**: Clear instance cache on auth failure (cleans up stale connections)
4. **Fix 6**: Session expired redirect (automatically redirects to login)

## Prerequisites

- Development environment running (`npm run dev`)
- Browser with DevTools open (Console tab visible)
- At least one document open in the editor

## Testing Methods

### Method 1: Using the "Expire Token" Button (Easiest)

This is the quickest way to test the auth flow in development.

1. **Open a document** in the editor
2. **Look for the red "🧪 Expire Token" button** in the top-right header (only visible in dev mode)
3. **Click the button**
4. **Observe the console logs** - you should see:
   ```
   [AuthContext] DEV: Manually expiring tokens
   [useYjs] Clearing instance cache due to auth failure
   [useYjs] Token state changed: {hasToken: false, hasProvider: true, ...}
   [useYjs] ⚠️ Token cleared while provider exists - AUTH FAILURE DETECTED
   [EditorView] Auth state check: {authError: true, isAuthenticated: false, ...}
   [EditorView] Auth error detected, redirecting to login in 1 second...
   [EditorView] Redirecting to: /login?returnTo=...
   ```
5. **You should be redirected to `/login` within 1 second**
6. **After logging in**, you should be returned to the document you were editing

**Expected Result**: ✅ Clean redirect to login page with no "Connecting..." state

### Method 2: Clearing Cookies (More Realistic)

This simulates what happens when a user's session actually expires.

1. **Open a document** in the editor
2. **Open DevTools** → **Application tab** → **Cookies**
3. **Find and delete the refresh token cookie** (usually named `refreshToken`)
4. **Trigger a token refresh** by either:
   - Waiting for the access token to expire (15 minutes - too long for testing)
   - OR making an API call that triggers the interceptor
   - OR use the "Expire Token" button to force immediate token clearing
5. **Observe the console** for the same logs as Method 1
6. **Verify you're redirected to login**

**Expected Result**: ✅ After token refresh fails, should redirect to login

### Method 3: Simulating Token Expiration via DevTools

For testing the flow when tokens expire naturally:

1. **Open a document**
2. **Open Console in DevTools**
3. **Run this command** to manually expire the token:
   ```javascript
   // Access the AuthContext via React DevTools or window
   // This will be exposed in dev mode only
   window.__expireTokenForTesting && window.__expireTokenForTesting();
   ```
4. **Observe the same redirect behavior**

### Method 4: Testing After Network Reconnection

This tests the scenario where connection is lost and restored, but tokens have expired.

1. **Open a document**
2. **Open DevTools** → **Network tab**
3. **Throttle to "Offline"** (simulates network loss)
4. **Wait a few seconds**
5. **Delete the refresh token cookie** (while still offline)
6. **Restore network** ("Online")
7. **WebSocket should attempt to reconnect**
8. **Should detect auth failure and redirect**

**Expected Result**: ✅ No infinite "Connecting..." - should detect auth failure and redirect

## What to Look For

### ✅ Success Indicators

1. **Console shows clear auth error detection**:
   - `[useYjs] ⚠️ Token cleared while provider exists - AUTH FAILURE DETECTED`
   - `[EditorView] Auth error detected, redirecting to login...`

2. **Red banner appears briefly**: "Session expired - Redirecting to login..."

3. **Automatic redirect** to `/login?returnTo=/d/{docGuid}`

4. **After re-login**, user is returned to the document they were editing

5. **No infinite "Connecting..." state**

6. **WebSocket connections are properly cleaned up** (check Network tab - no repeated failed WebSocket connections)

### ❌ Failure Indicators

1. **Stuck in "Connecting..." state** - indicates Fix 1 isn't working

2. **No redirect to login** - indicates Fix 6 isn't triggering

3. **Repeated WebSocket connection attempts** in Network tab - indicates Fix 3 isn't clearing cache

4. **No auth error logs in console** - indicates Fix 2 detection isn't working

5. **Console errors or exceptions** - indicates a bug in the implementation

## Console Logging Guide

When testing, you should see these logs in sequence:

### Normal Flow (Working)
```
[AuthContext] DEV: Manually expiring tokens
[useYjs] Clearing instance cache due to auth failure
[useYjs] Token state changed: {hasToken: false, hasProvider: true, currentAuthError: false, docGuid: "..."}
[useYjs] ⚠️ Token cleared while provider exists - AUTH FAILURE DETECTED
[EditorView] Auth state check: {authError: true, isAuthenticated: false, accessToken: false}
[EditorView] Auth error detected, redirecting to login in 1 second...
[EditorView] Redirecting to: /login?returnTo=/d/{docGuid}
```

### Broken Flow (Not Working)
```
# If you see this, something is wrong:
[useYjs] Token state changed: {hasToken: false, hasProvider: true, ...}
[EditorView] Auth state check: {authError: false, isAuthenticated: false, ...}
# No redirect happens - user stuck
```

## Edge Cases to Test

### 1. Multiple Tabs Open
1. Open the same document in **2-3 browser tabs**
2. In **one tab**, click "Expire Token"
3. **All tabs** should redirect to login (may need to refresh other tabs to trigger)

### 2. Version History View
1. Open a document's **version history** (`/d/{id}/versions`)
2. Click "Expire Token"
3. Should redirect to login with correct return URL

### 3. Rapid Token Changes
1. Click "Expire Token"
2. **Immediately click it again** (before redirect)
3. Should still redirect cleanly without errors

### 4. While Editing
1. Start typing in a document
2. **While typing**, click "Expire Token"
3. Should redirect without data loss (data is in IndexedDB)
4. After re-login, document should still have unsaved changes

## Troubleshooting

### "I don't see the Expire Token button"
- Make sure you're running in **development mode** (`npm run dev`)
- Check that `import.meta.env.DEV` is true
- Try refreshing the page

### "Clicking Expire Token doesn't redirect"
1. **Check console for errors**
2. **Verify logs show**:
   - `[AuthContext] DEV: Manually expiring tokens`
   - `[useYjs] ⚠️ Token cleared while provider exists`
   - `[EditorView] Auth state check: {authError: true, isAuthenticated: false}`
3. **If authError stays false**, check that the useEffect in useYjs.js is running
4. **If isAuthenticated stays true**, there's an issue with AuthContext state updates

### "Redirect happens but I get a 404"
- The `/login` route should exist in your app
- Check `App.jsx` routing configuration
- Make sure `LoginPage` component is imported

### "After re-login, I'm not returned to the document"
- Check that the `returnTo` parameter is in the URL
- Verify `App.jsx` handles the `returnTo` parameter (lines 147-156)
- The flow should be: Login → Check returnTo → Redirect to returnTo URL

## Expected Production Behavior

In production (without the dev button):

1. **Access token expires** (after 15 minutes of inactivity)
2. **Next API call** triggers refresh attempt via axios interceptor
3. **If refresh token is valid**: New access token issued, user continues
4. **If refresh token expired** (after 7 days):
   - AuthContext sets `accessToken = null`, `user = null`
   - useYjs detects token clearing
   - Sets `authError = true`
   - EditorView redirects to login
5. **User logs in**, redirected back to document

## Performance Testing

### Check for Memory Leaks
1. Open a document
2. Click "Expire Token"
3. **Before redirect**, open DevTools → **Memory tab**
4. Take a **heap snapshot**
5. Check that **WebSocket connections are closed**
6. **No dangling Yjs instances** should remain

### Check Network Efficiency
1. Open **Network tab** in DevTools
2. Click "Expire Token"
3. **Should NOT see**:
   - Repeated WebSocket connection attempts
   - Failed WebSocket upgrade requests looping
4. **Should see**:
   - WebSocket cleanly closed
   - Single redirect navigation

## Automated Testing (Future)

To add automated tests for this flow:

```javascript
describe('Auth expiration flow', () => {
  it('should redirect to login when token expires', async () => {
    // 1. Render EditorView with valid auth
    // 2. Call expireTokenForTesting()
    // 3. Wait for redirect
    // 4. Assert window.location.href includes '/login?returnTo='
  });

  it('should clear WebSocket cache on auth failure', () => {
    // 1. Create document with active WebSocket
    // 2. Trigger auth failure
    // 3. Assert instanceCache is cleared
    // 4. Assert provider.destroy() was called
  });
});
```

## Summary Checklist

Before considering the auth fixes complete, verify:

- [ ] "Expire Token" button works in dev mode
- [ ] Console shows clear auth error detection logs
- [ ] Redirect to login happens within 1-2 seconds
- [ ] Return URL is preserved (`returnTo` parameter)
- [ ] After re-login, user returns to document
- [ ] No infinite "Connecting..." state
- [ ] WebSocket cache is cleared (no memory leaks)
- [ ] No repeated failed WebSocket attempts
- [ ] Works in multiple tabs
- [ ] Works in version history view
- [ ] No console errors or exceptions

## Additional Notes

- The 1-second delay before redirect is intentional - allows time to see logs and state
- In production, you can reduce this delay or remove it for immediate redirect
- The auth fixes are defensive - they shouldn't break existing functionality
- Test both with and without `VITE_BYPASS_AUTH=true`
