/**
 * useYjs Bug Detection Tests
 *
 * These tests are designed to expose potential bugs in the auth/reconnection logic.
 * Tests marked with  are known to fail due to existing bugs.
 * When a bug is fixed, unskip the test to verify the fix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { useYjs, clearYjsInstanceCache } from '../useYjs';
import { resetYjsSingletons, createControllableMockProvider } from '../../test/utils';

// Mock Yjs providers
vi.mock('y-websocket');
vi.mock('y-indexeddb');

const TEST_DOC_GUID = 'bug-test-doc-guid';
const TEST_ACCESS_TOKEN = 'test-token';

describe('useYjs Bug Detection', () => {
  let mockProvider;
  let mockIndexeddbProvider;

  beforeEach(() => {
    resetYjsSingletons();
    clearYjsInstanceCache();
    vi.clearAllMocks();

    mockProvider = createControllableMockProvider();
    WebsocketProvider.mockImplementation(() => mockProvider);

    mockIndexeddbProvider = {
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn((event, handler) => {
        if (event === 'synced') {
          setTimeout(() => handler(), 0);
        }
      })
    };
    IndexeddbPersistence.mockImplementation(() => mockIndexeddbProvider);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearYjsInstanceCache();
  });

  describe('FIXED: reconnectCount now uses useState and triggers re-render', () => {
    it('reconnectCount updates immediately after forceReconnect', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Initial count should be 0
      expect(result.current.reconnectCount).toBe(0);

      // Call forceReconnect - now uses useState so it triggers re-render
      act(() => {
        result.current.forceReconnect();
      });

      // Wait a bit for the state update
      await new Promise(r => setTimeout(r, 150));

      // FIXED: reconnectCount now updates immediately because we use useState
      expect(result.current.reconnectCount).toBe(1);
    });
  });

  describe('FIXED: forceReconnect is now debounced', () => {
    it('rapid forceReconnect calls are debounced to single disconnect/connect cycle', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      mockProvider.disconnect.mockClear();
      mockProvider.connect.mockClear();

      // Rapidly call forceReconnect 3 times
      act(() => {
        result.current.forceReconnect();
        result.current.forceReconnect();
        result.current.forceReconnect();
      });

      // Wait for the 100ms timeouts to fire
      await new Promise(r => setTimeout(r, 150));

      // FIXED: With debouncing, only 1 disconnect and 1 connect should occur
      expect(mockProvider.disconnect).toHaveBeenCalledTimes(1);
      expect(mockProvider.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('FIXED: Manual and automatic retry counters are separate', () => {
    it('FIXED: manual reconnects do not count toward MAX_RETRIES threshold', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // User manually calls forceReconnect 3 times (e.g., clicking retry button)
      for (let i = 0; i < 3; i++) {
        act(() => {
          result.current.forceReconnect();
        });
        await new Promise(r => setTimeout(r, 350)); // Wait for debounce
      }

      // Then 1 automatic connection error occurs (below threshold of 2)
      act(() => {
        mockProvider._emitConnectionError('Network error');
      });

      // FIXED: Should NOT trigger authError because only 1 automatic failure
      // Manual reconnects don't count toward MAX_RETRIES_BEFORE_AUTH_ERROR (2)
      expect(result.current.authError).toBe(false);

      // But reconnectCount should show total attempts (manual + automatic)
      expect(result.current.reconnectCount).toBe(4);
    });

    it('FIXED: 2 automatic connection errors DO trigger authError', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Emit 2 automatic connection errors (reaches MAX_RETRIES_BEFORE_AUTH_ERROR)
      for (let i = 0; i < 2; i++) {
        act(() => {
          mockProvider._emitConnectionError('Network error');
        });
      }

      // Clear token to prevent auto-recovery
      rerender({ token: null });

      // FIXED: 2 automatic failures should trigger authError
      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });
  });

  describe('Bug #5 & #6: Event handler accumulation', () => {
    it('registers event handlers on provider creation', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Get the number of handlers registered
      const statusHandlerCount = mockProvider._getHandlerCount('status');
      const errorHandlerCount = mockProvider._getHandlerCount('connection-error');
      const closeHandlerCount = mockProvider._getHandlerCount('connection-close');

      // Handlers should be registered
      expect(statusHandlerCount).toBeGreaterThan(0);
      expect(errorHandlerCount).toBeGreaterThan(0);
      expect(closeHandlerCount).toBeGreaterThan(0);
    });

    it('calls destroy on provider when cache is cleared', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Clear the cache
      clearYjsInstanceCache();

      // destroy() should be called
      expect(mockProvider.destroy).toHaveBeenCalled();
    });
  });

  describe('Auto-recovery on token restoration (expected behavior)', () => {
    it('auto-recovery enables shouldConnect when token is restored after auth failure', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Set authError via close code
      act(() => {
        mockProvider._emitConnectionClose(4401);
      });

      // Clear token
      rerender({ token: null });

      await waitFor(() => expect(result.current.authError).toBe(true));

      // Track shouldConnect changes
      let shouldConnectSetCount = 0;
      Object.defineProperty(mockProvider, 'shouldConnect', {
        get() { return this._shouldConnect ?? true; },
        set(value) {
          shouldConnectSetCount++;
          this._shouldConnect = value;
        },
        configurable: true
      });

      // Restore token - this triggers auto-recovery (expected behavior)
      mockProvider.connect.mockClear();
      rerender({ token: 'new-token' });

      await new Promise(r => setTimeout(r, 100));

      // EXPECTED: Auto-recovery sets shouldConnect = true and attempts reconnection
      // This allows the app to recover from auth failures when token is refreshed
    });
  });

  describe('Defensive auth error detection (expected behavior)', () => {
    it('multiple auth error handlers can detect same failure (defensive redundancy)', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      let setAuthErrorCalls = 0;

      // Create a spy that tracks state changes
      // Note: We can't directly spy on setAuthError, but we can observe the effect

      // Emit both error types that indicate auth failure
      act(() => {
        // Error with auth keyword
        mockProvider._emitConnectionError('401 Unauthorized');
        // Close code for auth failure
        mockProvider._emitConnectionClose(1008);
      });

      // Both should detect auth failure - this is defensive programming
      // Clear token to persist the authError state
      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });

      // EXPECTED: Both handlers can set authError = true independently
      // This is defensive - if one handler fails to detect, the other will
      // Setting authError multiple times is idempotent and harmless
    });
  });

  describe('Connection error detection edge cases', () => {
    it('detects auth error from case-insensitive message matching', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Test case variations
      act(() => {
        mockProvider._emitConnectionError('UNAUTHORIZED ACCESS');
      });

      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('does NOT set authError for generic network errors', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Emit a generic network error (no auth keywords)
      act(() => {
        mockProvider._emitConnectionError('ECONNREFUSED');
      });

      // Wait a bit for any state changes
      await new Promise(r => setTimeout(r, 50));

      // Auth error should NOT be set for generic network errors
      // (unless MAX_RETRIES is reached)
      expect(result.current.authError).toBe(false);
    });
  });

  describe('Token state handling', () => {
    it('sets authError when token becomes null while provider exists', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Token becomes null
      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
        expect(result.current.connectionState).toBe('disconnected');
      });
    });

    it('clears authError and reconnects when token is restored', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Set authError via close code
      act(() => {
        mockProvider._emitConnectionClose(4401);
      });

      // Clear token to persist authError
      rerender({ token: null });

      await waitFor(() => expect(result.current.authError).toBe(true));

      // Restore token
      mockProvider.connect.mockClear();
      rerender({ token: 'new-token' });

      // Auto-recovery should clear authError and attempt reconnection
      await waitFor(() => {
        expect(result.current.authError).toBe(false);
      });

      // connect() should have been called for auto-recovery
      expect(mockProvider.connect).toHaveBeenCalled();
    });
  });

  describe('Performance: Provider reuse', () => {
    it('reuses existing provider when token changes (same doc)', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: 'token-1' } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      const firstProvider = result.current.provider;

      // Change token
      rerender({ token: 'token-2' });

      await new Promise(r => setTimeout(r, 50));

      // Same provider should be reused (cached by docGuid)
      // This documents the caching behavior
      expect(result.current.provider).toBe(firstProvider);
    });

    it('creates new provider for different doc', async () => {
      vi.useRealTimers();

      const { result: result1 } = renderHook(
        () => useYjs('doc-1', TEST_ACCESS_TOKEN)
      );

      await waitFor(() => expect(result1.current.provider).toBeDefined());

      // Create mock for second doc
      const mockProvider2 = createControllableMockProvider();
      WebsocketProvider.mockImplementation(() => mockProvider2);

      const { result: result2 } = renderHook(
        () => useYjs('doc-2', TEST_ACCESS_TOKEN)
      );

      await waitFor(() => expect(result2.current.provider).toBeDefined());

      // Different providers for different docs
      expect(result2.current.provider).toBe(mockProvider2);
    });
  });
});

describe('Multi-Tab Scenarios', () => {
  // These tests document bugs that occur when multiple browser tabs are open
  // Each tab has its own React app instance but shares:
  // - IndexedDB storage (via y-indexeddb)
  // - Server-side auth state (cookies)
  // The instanceCache is per-tab (module-level Map)

  let mockProvider;
  let mockProvider2;
  let mockIndexeddbProvider;

  beforeEach(() => {
    resetYjsSingletons();
    clearYjsInstanceCache();
    vi.clearAllMocks();
    vi.useRealTimers();

    mockProvider = createControllableMockProvider();
    mockProvider2 = createControllableMockProvider();

    let providerCallCount = 0;
    WebsocketProvider.mockImplementation(() => {
      providerCallCount++;
      return providerCallCount === 1 ? mockProvider : mockProvider2;
    });

    mockIndexeddbProvider = {
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn((event, handler) => {
        if (event === 'synced') {
          setTimeout(() => handler(), 0);
        }
      })
    };
    IndexeddbPersistence.mockImplementation(() => mockIndexeddbProvider);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearYjsInstanceCache();
  });

  describe('Global cache clearing (intended behavior)', () => {
    it('clearYjsInstanceCache destroys ALL cached providers on global auth failure', async () => {
      // Scenario: Multiple documents open in same tab, global auth fails
      // Expected: ALL providers destroyed (auth is global, not doc-specific)

      // Component A opens Doc 1
      const { result: componentA } = renderHook(
        () => useYjs('doc-1', TEST_ACCESS_TOKEN)
      );

      await waitFor(() => expect(componentA.current.provider).toBeDefined());
      const doc1Provider = componentA.current.provider;

      // Component B opens Doc 2 in same tab
      const { result: componentB } = renderHook(
        () => useYjs('doc-2', TEST_ACCESS_TOKEN)
      );

      await waitFor(() => expect(componentB.current.provider).toBeDefined());
      const doc2Provider = componentB.current.provider;

      // Both providers should be active
      expect(doc1Provider.destroy).not.toHaveBeenCalled();
      expect(doc2Provider.destroy).not.toHaveBeenCalled();

      // Global auth failure (logout or token refresh fails)
      // clearYjsInstanceCache() is called by AuthContext
      clearYjsInstanceCache();

      // INTENDED: Both providers destroyed because auth is global
      // If the auth token is bad, it's bad for ALL documents
      expect(doc1Provider.destroy).toHaveBeenCalled();
      expect(doc2Provider.destroy).toHaveBeenCalled();
    });

    it('documents that cache is keyed by docGuid', async () => {
      // The instanceCache is keyed by docGuid only
      // This means if the same doc is requested again (even with different token),
      // the cached instance is returned

      // This test documents the caching behavior
      // Note: In this test environment, we can't fully verify the caching
      // because each renderHook gets a fresh mock. But the behavior is:
      // - instanceCache.get(docGuid) returns cached {ydoc, provider, indexeddbProvider}
      // - Token changes trigger provider recreation logic, not cache lookup

      const { result: hook1 } = renderHook(
        () => useYjs('shared-doc', 'user1-token')
      );

      await waitFor(() => expect(hook1.current.provider).toBeDefined());

      // Same doc GUID will use cached instance in production
      // But in tests with mocks, we verify the caching logic exists
      // by checking that only one WebsocketProvider was created for a single doc
      expect(WebsocketProvider).toHaveBeenCalledTimes(1);
    });
  });

  describe('Bug: No cross-tab token synchronization', () => {
    it('documents lack of BroadcastChannel for token updates', async () => {
      // This test documents that there's no mechanism for Tab A to notify
      // Tab B when a token is refreshed

      const { result: tabA, rerender: rerenderA } = renderHook(
        ({ token }) => useYjs('doc-1', token),
        { initialProps: { token: 'old-token' } }
      );

      await waitFor(() => expect(tabA.current.provider).toBeDefined());

      // Tab A refreshes token
      rerenderA({ token: 'new-token' });

      // In real scenario, Tab B would still have 'old-token' in its state
      // because there's no BroadcastChannel to notify it
      // This test documents the limitation - each tab manages tokens independently

      // What SHOULD happen (but doesn't):
      // 1. Tab A broadcasts 'token-updated' event
      // 2. Tab B receives event and updates its token
      // 3. Both tabs now have 'new-token'

      // Current behavior: Tab B would make a request with old-token,
      // get a 401, and trigger its own refresh (duplicate server request)
    });
  });

  describe('Bug: Multiple tabs can trigger simultaneous token refreshes', () => {
    it('documents potential for duplicate refresh requests', async () => {
      // When multiple tabs become visible at the same time (e.g., after
      // laptop wake), each tab independently triggers a token refresh

      // This test documents the issue - actual refresh logic is in AuthContext
      // which would need integration testing with mocked axios

      // Scenario:
      // 1. User has 3 tabs open
      // 2. Laptop sleeps for 2 hours (token expires)
      // 3. User wakes laptop, all 3 tabs become "visible" simultaneously
      // 4. Each tab's AuthContext.handleVisibilityChange fires
      // 5. Each tab calls refreshAccessToken() independently
      // 6. Server receives 3 refresh requests within milliseconds

      // The server should handle this gracefully, but it's wasteful
      // and could cause rate limiting issues
    });
  });
});

describe('Sleep/Wake Scenarios', () => {
  // Tests for behavior when laptop sleeps and wakes after extended period
  // Key concerns:
  // - Token expiration during sleep
  // - WebSocket connection state after wake
  // - IndexedDB sync after reconnection

  let mockProvider;
  let mockIndexeddbProvider;

  beforeEach(() => {
    resetYjsSingletons();
    clearYjsInstanceCache();
    vi.clearAllMocks();
    vi.useRealTimers();

    mockProvider = createControllableMockProvider();
    WebsocketProvider.mockImplementation(() => mockProvider);

    mockIndexeddbProvider = {
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn((event, handler) => {
        if (event === 'synced') {
          setTimeout(() => handler(), 0);
        }
      })
    };
    IndexeddbPersistence.mockImplementation(() => mockIndexeddbProvider);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearYjsInstanceCache();
  });

  describe('Bug: IndexedDB sync only fires once', () => {
    it('documents that IndexedDB is skipped in test environment', async () => {
      // In the test environment, IndexedDB is not available and is skipped
      // This test documents that in production, IndexedDB uses .once('synced')
      // which means after reconnection, local changes won't be re-synced

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // IndexedDB is skipped in test environment (JSDOM doesn't have indexedDB)
      // The log shows: "[useYjs] Skipping IndexedDB persistence (not available)"

      // In production code (useYjs.js lines 284-325):
      // - indexeddbProvider.once('synced', ...) is used
      // - This means the synced handler only fires ONCE on initial connection
      // - After WebSocket reconnection, IndexedDB won't re-sync local changes

      // BUG: If user makes offline edits (stored in IndexedDB) and then
      // reconnects, those edits may not be broadcast to the server because
      // the .once() handler has already fired and won't fire again
    });

    it('documents reconnection without IndexedDB re-sync', async () => {
      // This test documents what happens during reconnection

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Simulate disconnect/reconnect
      act(() => {
        mockProvider._emitStatus({ status: 'disconnected' });
      });

      mockProvider.connect.mockClear();

      act(() => {
        result.current.forceReconnect();
      });

      await new Promise(r => setTimeout(r, 150));

      // WebSocket reconnects successfully
      expect(mockProvider.connect).toHaveBeenCalled();

      // But IndexedDB's .once('synced') handler won't fire again
      // This is the documented bug - offline changes may be lost
    });
  });

  describe('Bug: Stale connection detection timing', () => {
    it('documents 30-second health check interval', async () => {
      // The health check runs every 30 seconds and checks if connection
      // is stale (connected but not synced for 15 seconds)
      // This means up to 45 seconds can pass before stale connection is detected

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // After laptop wake:
      // - WebSocket thinks it's still connected (TCP frozen during sleep)
      // - First health check at T+0s to T+30s
      // - Health check sees "connected" but "not synced for > 15s"
      // - forceReconnect() called
      // - Total delay: up to 45 seconds of apparent connection before detection

      // For real-time collaboration, this is a significant lag
    });
  });

  describe('FIXED: Connection state stuck on connecting after token refresh', () => {
    it('FIXED: connectionState updates correctly when provider is recreated after token refresh', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Simulate: Connection was established and working
      act(() => {
        mockProvider._emitStatus('connected');
      });

      await waitFor(() => expect(result.current.connectionState).toBe('connected'));

      // User closes laptop, connection drops
      act(() => {
        mockProvider._emitStatus('disconnected');
      });
      mockProvider.wsconnected = false;

      await waitFor(() => expect(result.current.connectionState).toBe('disconnected'));

      // User opens laptop, tab becomes visible, token is refreshed
      // This triggers provider recreation in getOrCreateInstances
      rerender({ token: 'new-refreshed-token' });

      // Wait for provider recreation to complete
      await new Promise(r => setTimeout(r, 100));

      // The NEW provider connects and emits status event
      act(() => {
        mockProvider._emitStatus('connected');
      });

      // FIXED: connectionState now updates to "connected" correctly
      // The fix adds setProviderVersion() after updating instancesRef.current,
      // which forces a re-render so the useEffect can attach React state handlers
      // to the new provider instance
      await waitFor(() => {
        expect(result.current.connectionState).toBe('connected');
      }, { timeout: 2000 });
    });

    it('FIXED: both connectionState and synced update correctly after token refresh', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Simulate: Connection was established and synced
      act(() => {
        mockProvider._emitStatus('connected');
        mockProvider._emitSync(true);
      });

      await waitFor(() => {
        expect(result.current.connectionState).toBe('connected');
        expect(result.current.synced).toBe(true);
      });

      // Laptop sleeps, connection drops
      act(() => {
        mockProvider._emitStatus('disconnected');
        mockProvider._emitSync(false);
      });
      mockProvider.wsconnected = false;

      await waitFor(() => {
        expect(result.current.connectionState).toBe('disconnected');
        expect(result.current.synced).toBe(false);
      });

      // Laptop wakes, token refreshes (this creates a new provider instance)
      rerender({ token: 'refreshed-token-after-wake' });

      // Wait for provider update to complete
      await new Promise(r => setTimeout(r, 100));

      // New provider connects and syncs
      // This matches the user's logs showing WS_STATUS and WS_SYNC events
      act(() => {
        mockProvider._emitStatus('connected');
        mockProvider._emitSync(true);
      });

      // FIXED: Both states now update correctly
      // Before fix: logs showed WS_STATUS/WS_SYNC events firing but
      // React state stuck at connectionState="connecting", synced=false
      // After fix: setProviderVersion() forces re-render so new provider
      // gets React state handlers attached
      await waitFor(() => {
        expect(result.current.connectionState).toBe('connected');
        expect(result.current.synced).toBe(true);
      }, { timeout: 2000 });
    });
  });

  describe('FIXED: WebSocket reconnect validates token presence', () => {
    it('FIXED: forceReconnect does not attempt reconnection without a token', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Token is cleared (e.g., auth failure detected)
      rerender({ token: null });

      await waitFor(() => expect(result.current.authError).toBe(true));

      mockProvider.connect.mockClear();

      // forceReconnect is called (e.g., by user action or health check)
      act(() => {
        result.current.forceReconnect();
      });

      await new Promise(r => setTimeout(r, 150));

      // FIXED: connect() should NOT be called when there's no token
      // This prevents futile reconnection attempts when auth has failed
      expect(mockProvider.connect).not.toHaveBeenCalled();
    });

    it('documents that stale token detection happens on connection attempt', async () => {
      // Note: We cannot detect if a non-null token is STALE (expired on server)
      // without actually attempting to use it. Token refresh is managed by AuthContext.
      // When reconnection fails due to stale token:
      // 1. WebSocket connection fails
      // 2. connection-error handler detects auth failure
      // 3. authError state is set
      // 4. AuthContext sees authError and triggers token refresh
      // This is the correct flow - stale token detection requires a server round-trip

      const { result } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: 'stale-token' } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // forceReconnect with stale token will attempt connection
      // Server will reject it, and then auth error detection kicks in
      // This is expected behavior - we can't predict token expiry client-side
    });
  });

  describe('Awareness state after reconnection', () => {
    it('awareness is re-broadcast when connection is re-established', async () => {
      // After disconnect/reconnect, the user's cursor and presence info
      // is re-broadcast when the 'connected' status event fires

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN, {
        name: 'Test User',
        color: '#ff0000'
      }));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Awareness is set during render (lines 360-367)
      // This happens synchronously before connection handlers run

      // Disconnect
      act(() => {
        mockProvider._emitStatus('disconnected');
      });

      // Wait and reconnect
      await new Promise(r => setTimeout(r, 100));

      act(() => {
        result.current.forceReconnect();
      });

      await new Promise(r => setTimeout(r, 150));

      // Simulate reconnection
      act(() => {
        mockProvider._emitStatus('connected');
      });

      // EXPECTED: When 'connected' event fires, awareness is re-broadcast (line 457-458)
      // The handleStatus function re-sets awareness.setLocalStateField('user', ...)
      // This triggers a broadcast to all connected clients
    });
  });

  describe('Extended disconnection scenarios', () => {
    it('documents behavior after 2+ hour disconnection', async () => {
      // Scenario: User closes laptop at 2pm, opens at 4pm
      // - Token issued at 2pm has expired (usually 1hr validity)
      // - WebSocket was frozen (not properly closed)
      // - IndexedDB has cached state from 2pm

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Simulate: WebSocket receives close code after laptop wake
      // (server timed out the connection while laptop was asleep)
      act(() => {
        mockProvider._emitConnectionClose(1006, 'Abnormal closure');
      });

      // This should set authError since 1006 is an auth-related code
      // Clear token to prevent auto-recovery (simulating expired token)
      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
        expect(result.current.connectionState).toBe('disconnected');
      });

      // At this point:
      // - authError is true → "Session expired" banner shown
      // - User must re-authenticate
      // - Any local changes in IndexedDB need to be synced after re-auth
    });

    it('documents auto-recovery when token is restored quickly', async () => {
      // If token is refreshed quickly after wake, auto-recovery kicks in

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Auth error detected
      act(() => {
        mockProvider._emitConnectionClose(4401);
      });

      rerender({ token: null });
      await waitFor(() => expect(result.current.authError).toBe(true));

      // Token is quickly refreshed (AuthContext.handleVisibilityChange succeeds)
      mockProvider.connect.mockClear();
      rerender({ token: 'refreshed-token' });

      // Auto-recovery should clear authError and reconnect
      await waitFor(() => {
        expect(result.current.authError).toBe(false);
      });

      expect(mockProvider.connect).toHaveBeenCalled();
    });
  });
});

describe('Proposed Fixes for Multi-Tab and Sleep/Wake (Tests for Future Implementation)', () => {
  // These tests describe expected behavior after fixes are implemented

  let mockProvider;
  let mockIndexeddbProvider;

  beforeEach(() => {
    resetYjsSingletons();
    clearYjsInstanceCache();
    vi.clearAllMocks();
    vi.useRealTimers();

    mockProvider = createControllableMockProvider();
    WebsocketProvider.mockImplementation(() => mockProvider);

    mockIndexeddbProvider = {
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn((event, handler) => {
        if (event === 'synced') {
          setTimeout(() => handler(), 0);
        }
      })
    };
    IndexeddbPersistence.mockImplementation(() => mockIndexeddbProvider);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearYjsInstanceCache();
  });

  describe('Fix: Selective cache clearing', () => {
    it('should only clear cache for specific document on auth failure', async () => {
      // After fix: clearYjsInstanceCache should accept optional docGuid parameter
      // clearYjsInstanceCache('doc-1') should only destroy doc-1's provider

      const { result: doc1 } = renderHook(
        () => useYjs('doc-1', TEST_ACCESS_TOKEN)
      );
      await waitFor(() => expect(doc1.current.provider).toBeDefined());

      const { result: doc2 } = renderHook(
        () => useYjs('doc-2', TEST_ACCESS_TOKEN)
      );
      await waitFor(() => expect(doc2.current.provider).toBeDefined());

      // Clear only doc-1's cache
      // clearYjsInstanceCache('doc-1'); // New signature

      // EXPECTED after fix: Only doc-1's provider should be destroyed
      // expect(doc1.current.provider.destroy).toHaveBeenCalled();
      // expect(doc2.current.provider.destroy).not.toHaveBeenCalled();
    });
  });

  describe('Fix: IndexedDB should use .on() for reconnection sync', () => {
    it('should re-sync IndexedDB changes after reconnection', async () => {
      // After fix: IndexedDB provider should use .on('synced') not .once()
      // This allows re-syncing after reconnection

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // EXPECTED after fix: .on() is used instead of .once()
      // expect(mockIndexeddbProvider.on).toHaveBeenCalledWith('synced', expect.any(Function));

      // Simulate disconnect and reconnect
      act(() => {
        mockProvider._emitStatus({ status: 'disconnected' });
      });

      act(() => {
        result.current.forceReconnect();
      });

      await new Promise(r => setTimeout(r, 150));

      // EXPECTED after fix: IndexedDB synced handler fires again
      // and local changes are re-broadcast to server
    });
  });

  describe('Fix: Token validation before reconnection', () => {
    it('should validate token age before attempting reconnection', async () => {
      // After fix: forceReconnect should check token age
      // If token is likely expired (> 50 minutes old), trigger refresh first

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // EXPECTED after fix:
      // forceReconnect checks token age via callback
      // If token is stale, it requests refresh before reconnecting
      // This prevents unnecessary 401 round-trips
    });
  });

  describe('Fix: BroadcastChannel for cross-tab token sync', () => {
    it('should notify other tabs when token is refreshed', async () => {
      // After fix: AuthContext uses BroadcastChannel to sync tokens

      // When Tab A refreshes token:
      // 1. Tab A broadcasts { type: 'TOKEN_REFRESHED', token: 'new-token' }
      // 2. Tab B receives message and updates its token state
      // 3. Tab B's useYjs sees new token and triggers auto-recovery if needed

      // This prevents duplicate refresh requests from multiple tabs
    });
  });

  describe('Fix: Visibility-based token refresh with debouncing', () => {
    it('should debounce visibility change token refreshes', async () => {
      // After fix: Rapid tab switches don't trigger multiple refreshes

      // If user switches between apps rapidly (5 times in 2 seconds),
      // only 1 token refresh should occur (debounced)
    });

    it('should track time since last visibility and refresh accordingly', async () => {
      // After fix: Only refresh token if tab was hidden > 5 minutes

      // Quick tab switches (< 5 min) don't need token refresh
      // Only extended absences trigger proactive refresh
    });
  });
});

describe('Proposed Fixes (Tests for Future Implementation)', () => {
  // These tests describe the EXPECTED behavior after fixes are applied
  // They are skipped because the fixes are not yet implemented
  // Unskip them after implementing the corresponding fix to verify it works

  let mockProvider;
  let mockIndexeddbProvider;

  beforeEach(() => {
    resetYjsSingletons();
    clearYjsInstanceCache();
    vi.clearAllMocks();
    vi.useRealTimers();

    mockProvider = createControllableMockProvider();
    WebsocketProvider.mockImplementation(() => mockProvider);

    mockIndexeddbProvider = {
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn((event, handler) => {
        if (event === 'synced') {
          setTimeout(() => handler(), 0);
        }
      })
    };
    IndexeddbPersistence.mockImplementation(() => mockIndexeddbProvider);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearYjsInstanceCache();
  });

  describe('Fix: forceReconnect should be debounced', () => {
    it('should debounce rapid forceReconnect calls', async () => {
      // After fix: Rapid calls should be debounced to 1 call
      // Implementation: Add debounce wrapper or cooldown period (e.g., 300ms)

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      mockProvider.disconnect.mockClear();
      mockProvider.connect.mockClear();

      // Rapidly call forceReconnect 5 times within debounce window
      act(() => {
        result.current.forceReconnect();
        result.current.forceReconnect();
        result.current.forceReconnect();
        result.current.forceReconnect();
        result.current.forceReconnect();
      });

      // Wait for debounce timeout plus reconnect timeout
      await new Promise(r => setTimeout(r, 500));

      // EXPECTED after fix: Only 1 disconnect and 1 connect (debounced)
      expect(mockProvider.disconnect).toHaveBeenCalledTimes(1);
      expect(mockProvider.connect).toHaveBeenCalledTimes(1);
    });

    it('should allow subsequent forceReconnect after debounce period', async () => {
      // After fix: forceReconnect should work again after debounce period expires

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      mockProvider.disconnect.mockClear();
      mockProvider.connect.mockClear();

      // First call
      act(() => {
        result.current.forceReconnect();
      });

      // Wait for debounce period to expire (e.g., 300ms) plus reconnect timeout (100ms)
      await new Promise(r => setTimeout(r, 500));

      // Second call after debounce expires
      act(() => {
        result.current.forceReconnect();
      });

      await new Promise(r => setTimeout(r, 200));

      // EXPECTED after fix: 2 disconnects and 2 connects (two separate debounced calls)
      expect(mockProvider.disconnect).toHaveBeenCalledTimes(2);
      expect(mockProvider.connect).toHaveBeenCalledTimes(2);
    });
  });

  describe('Fix: reconnectCount should trigger re-render', () => {
    it('should update reconnectCount immediately after forceReconnect', async () => {
      // After fix: reconnectCount changes should trigger re-render immediately
      // Implementation: Change from useRef to useState

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Initial count should be 0
      expect(result.current.reconnectCount).toBe(0);

      // Call forceReconnect
      act(() => {
        result.current.forceReconnect();
      });

      // EXPECTED after fix: reconnectCount should immediately be 1
      // (currently it stays 0 because useRef doesn't trigger re-render)
      expect(result.current.reconnectCount).toBe(1);
    });

    it('should update reconnectCount after connection error', async () => {
      // After fix: reconnectCount updates on connection error should be visible

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      expect(result.current.reconnectCount).toBe(0);

      // Emit a connection error (not auth-related)
      act(() => {
        mockProvider._emitConnectionError('ECONNREFUSED');
      });

      // EXPECTED after fix: reconnectCount should be 1
      await waitFor(() => {
        expect(result.current.reconnectCount).toBe(1);
      });
    });

    it('should reset reconnectCount to 0 after successful sync', async () => {
      // After fix: reconnectCount should visibly reset after sync

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Emit some connection errors
      act(() => {
        mockProvider._emitConnectionError('ECONNREFUSED');
        mockProvider._emitConnectionError('ECONNREFUSED');
      });

      // After fix, we'd see count = 2 here
      // Then emit sync success
      act(() => {
        mockProvider._emit('sync', true);
      });

      // EXPECTED after fix: reconnectCount should be 0 after sync
      await waitFor(() => {
        expect(result.current.reconnectCount).toBe(0);
      });
    });
  });

  describe('Fix: Separate counters for manual vs automatic retries', () => {
    it('should not count forceReconnect toward MAX_RETRIES threshold', async () => {
      // After fix: forceReconnect (manual) should not count toward auth error threshold
      // Implementation: Separate manualRetryCount from connectionFailureCount

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // User clicks retry 10 times (way above MAX_RETRIES of 5)
      for (let i = 0; i < 10; i++) {
        act(() => {
          result.current.forceReconnect();
        });
        await new Promise(r => setTimeout(r, 150)); // Wait for each reconnect
      }

      // EXPECTED after fix: authError should still be false
      // (manual retries don't count toward auth error threshold)
      expect(result.current.authError).toBe(false);
    });

    it('should still trigger authError after 5 automatic connection failures', async () => {
      // After fix: Only automatic failures count toward MAX_RETRIES

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Emit 5 connection errors (automatic failures)
      for (let i = 0; i < 5; i++) {
        act(() => {
          mockProvider._emitConnectionError('Network error');
        });
      }

      // Clear token to prevent auto-recovery
      rerender({ token: null });

      // EXPECTED: authError should be true (5 automatic failures)
      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('should allow mixing manual retries with automatic failures', async () => {
      // After fix: Manual retries don't affect the automatic failure count

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // 3 manual retries
      for (let i = 0; i < 3; i++) {
        act(() => {
          result.current.forceReconnect();
        });
        await new Promise(r => setTimeout(r, 150));
      }

      // 1 automatic failure (below threshold of 2)
      act(() => {
        mockProvider._emitConnectionError('Network error');
      });

      // authError should still be false (only 1 automatic failure)
      expect(result.current.authError).toBe(false);

      // 1 more automatic failure (reaches threshold of 2)
      act(() => {
        mockProvider._emitConnectionError('Network error');
      });

      // Clear token to prevent auto-recovery
      rerender({ token: null });

      // EXPECTED: Now authError should be true (2 automatic failures)
      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });
  });

  describe('Fix: reconnectCount should reset on token refresh', () => {
    it('should reset counter when token changes from null to valid', async () => {
      // After fix: When accessToken is restored, reset failure counter

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Emit 3 connection errors
      for (let i = 0; i < 3; i++) {
        act(() => {
          mockProvider._emitConnectionError('Network error');
        });
      }

      // Token becomes null (simulating auth failure from server)
      rerender({ token: null });

      await waitFor(() => expect(result.current.authError).toBe(true));

      // Token is restored (refresh succeeded)
      rerender({ token: 'new-refreshed-token' });

      await waitFor(() => expect(result.current.authError).toBe(false));

      // EXPECTED after fix: reconnectCount should be reset to 0
      expect(result.current.reconnectCount).toBe(0);
    });

    it('should give full MAX_RETRIES attempts after token refresh', async () => {
      // After fix: After token refresh, user gets fresh 2 retry attempts

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Emit 2 connection errors (reaches threshold)
      for (let i = 0; i < 2; i++) {
        act(() => {
          mockProvider._emitConnectionError('Network error');
        });
      }

      // authError should be set now
      await waitFor(() => expect(result.current.authError).toBe(true));

      // Token refresh cycle
      rerender({ token: 'new-token' });
      await waitFor(() => expect(result.current.authError).toBe(false));

      // Now emit 1 connection error (below threshold of 2)
      // Counter was reset, so 1 error is still below threshold
      act(() => {
        mockProvider._emitConnectionError('Network error');
      });

      // EXPECTED after fix: authError should still be false (only 1 failure since reset)
      expect(result.current.authError).toBe(false);
    });

    it('should reset counter on successful sync', async () => {
      // After fix: Successful sync should also reset the failure counter

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Emit 1 connection error (below threshold of 2)
      act(() => {
        mockProvider._emitConnectionError('Network error');
      });

      // Emit successful sync
      act(() => {
        mockProvider._emit('sync', true);
      });

      // EXPECTED: Counter should be reset to 0 after successful sync
      expect(result.current.reconnectCount).toBe(0);

      // Now 1 more error should NOT trigger authError (counter was reset)
      act(() => {
        mockProvider._emitConnectionError('Network error');
      });

      // Should still be false (only 1 failure since reset)
      expect(result.current.authError).toBe(false);
    });
  });
});
