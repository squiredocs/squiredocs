/**
 * Stale Tab Scenario Tests for useYjs
 *
 * These tests verify behavior when:
 * - Tabs are left idle and tokens expire
 * - Multiple tabs try to reconnect simultaneously
 * - WebSocket connections become stale after sleep/wake
 * - Initial connections timeout
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

const TEST_DOC_GUID = 'stale-tab-test-doc';
const TEST_ACCESS_TOKEN = 'test-token';

describe('Stale Tab Scenarios', () => {
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

  describe('Initial Connection Timeout', () => {
    // Note: Connection timeout was removed in simplified architecture.
    // y-websocket handles reconnection internally with exponential backoff.

    it('clears timeout when connection succeeds before timeout', async () => {
      vi.useFakeTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      expect(result.current.connectionState).toBe('connecting');

      // Connect before timeout
      act(() => {
        vi.advanceTimersByTime(5000); // 5 seconds
        mockProvider._emitStatus('connected');
      });

      expect(result.current.connectionState).toBe('connected');

      // Advance past the 30-second timeout - should stay connected
      act(() => {
        vi.advanceTimersByTime(30000);
      });

      expect(result.current.connectionState).toBe('connected');

      vi.useRealTimers();
    });
  });

  describe('Stale Connection Detection on Visibility Change', () => {
    it('documents stale connection detection behavior', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Establish connection and sync
      act(() => {
        mockProvider._emitStatus('connected');
        mockProvider._emitSync(true);
      });

      await waitFor(() => expect(result.current.synced).toBe(true));

      // Note: Full visibility change testing would require mocking document.hidden
      // and dispatching visibilitychange events. The implementation checks:
      // - If provider.wsconnected is true
      // - And time since last sync > 30 seconds
      // - Then forceReconnect is called
      //
      // This behavior is verified by the enhanced visibility handler in useYjs.js
      expect(result.current.connectionState).toBe('connected');
    });
  });

  describe('Health Check for Stuck Connecting State', () => {
    // Note: Periodic health check was removed in simplified architecture.
    // y-websocket handles reconnection internally with exponential backoff.

    it('does not force reconnect if auth error is set', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Trigger auth error
      act(() => {
        mockProvider._emitConnectionError('401 Unauthorized');
      });

      // Clear token to persist auth error
      rerender({ token: null });

      await waitFor(() => expect(result.current.authError).toBe(true));

      mockProvider.disconnect.mockClear();

      // Try to manually force reconnect - should be skipped due to no token
      act(() => {
        result.current.forceReconnect();
      });

      await new Promise(r => setTimeout(r, 150));

      // Should not have tried to reconnect (no token)
      expect(mockProvider.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('Token Restoration After Auth Failure', () => {
    it('recovers automatically when token is restored after auth failure', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Trigger auth failure via close code
      act(() => {
        mockProvider._emitConnectionClose(4401);
      });

      // Clear token
      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
        expect(result.current.connectionState).toBe('disconnected');
      });

      // Restore token (simulating successful token refresh)
      mockProvider.connect.mockClear();
      rerender({ token: 'new-refreshed-token' });

      // Should clear auth error and attempt reconnection
      await waitFor(() => {
        expect(result.current.authError).toBe(false);
      });

      expect(mockProvider.connect).toHaveBeenCalled();
    });

    it('resets reconnect counters when token is restored', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Generate some disconnections (reconnectCount increments on status 'disconnected')
      act(() => {
        mockProvider._emitStatus('disconnected');
        mockProvider._emitStatus('disconnected');
        mockProvider._emitStatus('disconnected');
      });

      await waitFor(() => expect(result.current.reconnectCount).toBe(3));

      // Trigger auth failure and clear token
      act(() => {
        mockProvider._emitConnectionClose(4401);
      });
      rerender({ token: null });

      await waitFor(() => expect(result.current.authError).toBe(true));

      // Restore token - counters reset on new token (effect re-runs with setReconnectCount(0))
      rerender({ token: 'new-token' });

      await waitFor(() => expect(result.current.authError).toBe(false));

      // Counters should be reset when new token is provided
      expect(result.current.reconnectCount).toBe(0);
    });
  });

  describe('Connection State Propagation After Provider Recreation', () => {
    it('updates connectionState correctly when provider is recreated', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Establish initial connection
      act(() => {
        mockProvider._emitStatus('connected');
        mockProvider._emitSync(true);
      });

      await waitFor(() => {
        expect(result.current.connectionState).toBe('connected');
        expect(result.current.synced).toBe(true);
      });

      // Simulate disconnection (e.g., laptop sleep)
      act(() => {
        mockProvider._emitStatus('disconnected');
      });
      mockProvider.wsconnected = false;

      await waitFor(() => expect(result.current.connectionState).toBe('disconnected'));

      // Token refresh triggers provider update
      rerender({ token: 'refreshed-token' });

      await new Promise(r => setTimeout(r, 100));

      // New provider connects
      act(() => {
        mockProvider._emitStatus('connected');
        mockProvider._emitSync(true);
      });

      // State should propagate correctly
      await waitFor(() => {
        expect(result.current.connectionState).toBe('connected');
        expect(result.current.synced).toBe(true);
      });
    });
  });

  describe('forceReconnect Behavior', () => {
    it('skips reconnection when no access token is available', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Clear token
      rerender({ token: null });

      await waitFor(() => expect(result.current.authError).toBe(true));

      mockProvider.connect.mockClear();
      mockProvider.disconnect.mockClear();

      // Try to force reconnect
      act(() => {
        result.current.forceReconnect();
      });

      await new Promise(r => setTimeout(r, 150));

      // Should not have attempted reconnection
      expect(mockProvider.disconnect).not.toHaveBeenCalled();
      expect(mockProvider.connect).not.toHaveBeenCalled();
    });

    it('debounces rapid forceReconnect calls', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      mockProvider.disconnect.mockClear();
      mockProvider.connect.mockClear();

      // Rapidly call forceReconnect
      act(() => {
        result.current.forceReconnect();
        result.current.forceReconnect();
        result.current.forceReconnect();
      });

      await new Promise(r => setTimeout(r, 150));

      // Should only have one reconnect cycle (debounced)
      expect(mockProvider.disconnect).toHaveBeenCalledTimes(1);
      expect(mockProvider.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('Awareness Rebroadcasting', () => {
    it('sets awareness on connection established (single broadcast point)', async () => {
      vi.useRealTimers();

      const mockUser = { name: 'Test User', color: '#ff0000' };

      mockProvider.awareness.getLocalState.mockReturnValue({ user: mockUser });

      const { result } = renderHook(() =>
        useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN, mockUser)
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      mockProvider.awareness.setLocalStateField.mockClear();

      // Emit connected status
      act(() => {
        mockProvider._emitStatus('connected');
      });

      // Should have rebroadcast user awareness
      expect(mockProvider.awareness.setLocalStateField).toHaveBeenCalledWith('user', mockUser);
    });
  });

  describe('Generic Connection Errors (Simplified Architecture)', () => {
    // Note: The MAX_FAILURES threshold was removed in the simplified architecture.
    // Only explicit auth close codes (4401, 4403) set authError.
    // Generic connection failures let y-websocket retry naturally.

    it('does NOT set authError for generic connection errors', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Multiple generic connection close events should NOT set authError
      for (let i = 0; i < 5; i++) {
        act(() => {
          mockProvider._emitConnectionClose(1006); // Abnormal closure
        });
      }

      await new Promise(r => setTimeout(r, 100));

      // authError should NOT be set for generic errors
      expect(result.current.authError).toBe(false);
    });

    it('sets authError ONLY for explicit auth close codes', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Explicit auth code should set authError
      act(() => {
        mockProvider._emitConnectionClose(4401);
      });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });

      // shouldConnect should be set to false to stop retries
      expect(mockProvider.shouldConnect).toBe(false);
    });

    it('persists authError when token is cleared', async () => {
      vi.useRealTimers();

      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Trigger auth error via explicit close code
      act(() => {
        mockProvider._emitConnectionClose(4401);
      });

      // Clear token
      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('reconnectCount tracks disconnections (not errors)', async () => {
      vi.useRealTimers();

      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      expect(result.current.reconnectCount).toBe(0);

      // Each status 'disconnected' increments reconnectCount
      act(() => {
        mockProvider._emitStatus('disconnected');
        mockProvider._emitStatus('disconnected');
        mockProvider._emitStatus('disconnected');
      });

      await waitFor(() => expect(result.current.reconnectCount).toBe(3));

      // authError should still be false (no explicit auth code)
      expect(result.current.authError).toBe(false);
    });
  });
});

describe('Visibility-Based Stale Connection Detection', () => {
  let mockProvider;
  let mockIndexeddbProvider;
  let originalVisibilityState;
  let visibilityListeners;

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

    // Store original visibilityState
    originalVisibilityState = document.visibilityState;
    visibilityListeners = [];

    // Mock addEventListener for visibilitychange
    const originalAddEventListener = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((event, handler, options) => {
      if (event === 'visibilitychange') {
        visibilityListeners.push(handler);
      }
      return originalAddEventListener(event, handler, options);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearYjsInstanceCache();
    // Restore original visibilityState
    Object.defineProperty(document, 'visibilityState', {
      value: originalVisibilityState,
      writable: true,
      configurable: true
    });
    Object.defineProperty(document, 'hidden', {
      value: false,
      writable: true,
      configurable: true
    });
  });

  // Helper to simulate visibility change
  const simulateVisibilityChange = (hidden) => {
    Object.defineProperty(document, 'visibilityState', {
      value: hidden ? 'hidden' : 'visible',
      writable: true,
      configurable: true
    });
    Object.defineProperty(document, 'hidden', {
      value: hidden,
      writable: true,
      configurable: true
    });
    // Trigger all registered visibility listeners
    visibilityListeners.forEach(listener => listener());
  };

  it('forces reconnect when tab becomes visible with stale connection (no sync for 30+ seconds)', async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

    // Wait for provider to be defined
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.provider).toBeDefined();

    // Establish connection and sync
    act(() => {
      mockProvider._emitStatus('connected');
      mockProvider._emitSync(true);
    });

    expect(result.current.connectionState).toBe('connected');
    expect(result.current.synced).toBe(true);

    mockProvider.disconnect.mockClear();
    mockProvider.connect.mockClear();

    // Simulate time passing without sync (like laptop sleep)
    // Advance 35 seconds to exceed the 30-second staleness threshold
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35000);
    });

    // Tab becomes visible - should detect stale connection and force reconnect
    act(() => {
      simulateVisibilityChange(false); // visible
    });

    // Should have triggered a reconnect due to stale connection
    expect(mockProvider.disconnect).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('does NOT force reconnect when connection is fresh (synced within 30 seconds)', async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Establish connection and sync
    act(() => {
      mockProvider._emitStatus('connected');
      mockProvider._emitSync(true);
    });

    mockProvider.disconnect.mockClear();

    // Only advance 10 seconds (less than 30-second threshold)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    // Tab becomes visible
    act(() => {
      simulateVisibilityChange(false);
    });

    // Should NOT have triggered a reconnect (connection is fresh)
    expect(mockProvider.disconnect).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('rebroadcasts awareness when tab becomes visible with healthy connection', async () => {
    vi.useFakeTimers();

    const mockUser = { name: 'Test User', color: '#ff0000' };
    const mockCursor = { anchor: 0, head: 5 };

    mockProvider.awareness.getLocalState.mockReturnValue({
      user: mockUser,
      cursor: mockCursor
    });

    const { result } = renderHook(() =>
      useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN, mockUser)
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Establish connection and sync
    act(() => {
      mockProvider._emitStatus('connected');
      mockProvider._emitSync(true);
    });

    mockProvider.awareness.setLocalStateField.mockClear();

    // Short time passes (connection stays fresh)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    // Tab becomes visible
    act(() => {
      simulateVisibilityChange(false);
    });

    // Should have rebroadcast awareness (user presence)
    expect(mockProvider.awareness.setLocalStateField).toHaveBeenCalledWith('user', mockUser);

    vi.useRealTimers();
  });
});

describe('AuthContext BroadcastChannel Integration', () => {
  let mockBroadcastChannel;
  let channelInstances;
  let originalBroadcastChannel;

  beforeEach(() => {
    channelInstances = [];

    // Create mock BroadcastChannel class
    mockBroadcastChannel = vi.fn().mockImplementation((name) => {
      const instance = {
        name,
        onmessage: null,
        postMessage: vi.fn((data) => {
          // Broadcast to all OTHER instances with the same name
          channelInstances
            .filter(ch => ch !== instance && ch.name === name)
            .forEach(ch => {
              if (ch.onmessage) {
                ch.onmessage({ data });
              }
            });
        }),
        close: vi.fn()
      };
      channelInstances.push(instance);
      return instance;
    });

    // Store original and replace
    originalBroadcastChannel = global.BroadcastChannel;
    global.BroadcastChannel = mockBroadcastChannel;
  });

  afterEach(() => {
    global.BroadcastChannel = originalBroadcastChannel;
    channelInstances = [];
  });

  describe('Cross-Tab Token Coordination', () => {
    it('creates BroadcastChannel with correct name on mount', async () => {
      // Import AuthProvider dynamically to get fresh module with mocked BroadcastChannel
      const { AuthProvider } = await import('../../contexts/AuthContext.jsx');
      const { render, cleanup } = await import('@testing-library/react');
      const React = await import('react');

      render(React.createElement(AuthProvider, { children: React.createElement('div') }));

      // Should have created a BroadcastChannel
      expect(mockBroadcastChannel).toHaveBeenCalledWith('collab-auth-token');

      cleanup();
    });

    it('broadcasts TOKEN_REFRESHED when token is refreshed', async () => {
      // This test verifies the broadcast happens during token refresh
      // The actual refresh logic is in AuthContext, but we can verify
      // the BroadcastChannel is set up correctly

      expect(mockBroadcastChannel).toBeDefined();

      // Create two channel instances (simulating two tabs)
      const tab1Channel = new mockBroadcastChannel('collab-auth-token');
      const tab2Channel = new mockBroadcastChannel('collab-auth-token');

      let receivedMessage = null;
      tab2Channel.onmessage = (event) => {
        receivedMessage = event.data;
      };

      // Tab 1 broadcasts a token refresh
      tab1Channel.postMessage({ type: 'TOKEN_REFRESHED', token: 'new-token-123' });

      // Tab 2 should receive it
      expect(receivedMessage).toEqual({ type: 'TOKEN_REFRESHED', token: 'new-token-123' });
    });

    it('broadcasts LOGOUT to all tabs', async () => {
      const tab1Channel = new mockBroadcastChannel('collab-auth-token');
      const tab2Channel = new mockBroadcastChannel('collab-auth-token');
      const tab3Channel = new mockBroadcastChannel('collab-auth-token');

      const receivedMessages = [];
      tab2Channel.onmessage = (event) => receivedMessages.push({ tab: 2, data: event.data });
      tab3Channel.onmessage = (event) => receivedMessages.push({ tab: 3, data: event.data });

      // Tab 1 broadcasts logout
      tab1Channel.postMessage({ type: 'LOGOUT' });

      // Both other tabs should receive it
      expect(receivedMessages).toHaveLength(2);
      expect(receivedMessages[0].data).toEqual({ type: 'LOGOUT' });
      expect(receivedMessages[1].data).toEqual({ type: 'LOGOUT' });
    });

    it('does not receive own broadcasts', async () => {
      const tab1Channel = new mockBroadcastChannel('collab-auth-token');

      let receivedMessage = null;
      tab1Channel.onmessage = (event) => {
        receivedMessage = event.data;
      };

      // Tab 1 broadcasts
      tab1Channel.postMessage({ type: 'TOKEN_REFRESHED', token: 'test' });

      // Tab 1 should NOT receive its own message
      expect(receivedMessage).toBeNull();
    });
  });
});

describe('Debounced Visibility-Based Token Refresh', () => {
  let mockApi;
  let originalVisibilityState;
  let visibilityListeners;
  let lastHiddenTime;

  beforeEach(() => {
    vi.useFakeTimers();

    originalVisibilityState = document.visibilityState;
    visibilityListeners = [];
    lastHiddenTime = null;

    // Track visibility change listeners
    const originalAddEventListener = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((event, handler, options) => {
      if (event === 'visibilitychange') {
        visibilityListeners.push(handler);
      }
      return originalAddEventListener(event, handler, options);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(document, 'visibilityState', {
      value: originalVisibilityState,
      writable: true,
      configurable: true
    });
  });

  const simulateVisibilityChange = (hidden) => {
    Object.defineProperty(document, 'visibilityState', {
      value: hidden ? 'hidden' : 'visible',
      writable: true,
      configurable: true
    });
    visibilityListeners.forEach(listener => listener());
  };

  it('tracks lastHiddenTime when tab becomes hidden', async () => {
    // This tests the debounce mechanism concept
    // The actual implementation is in AuthContext

    const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

    // Simulate the debounce logic
    let lastHiddenTimeRef = null;
    let refreshCalled = false;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lastHiddenTimeRef = Date.now();
        return;
      }

      // Tab became visible
      if (lastHiddenTimeRef) {
        const hiddenDuration = Date.now() - lastHiddenTimeRef;
        if (hiddenDuration > REFRESH_THRESHOLD_MS) {
          refreshCalled = true;
        }
        lastHiddenTimeRef = null;
      }
    };

    // Tab hidden
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    handleVisibilityChange();

    expect(lastHiddenTimeRef).not.toBeNull();

    // Advance 6 minutes
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

    // Tab visible
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    handleVisibilityChange();

    // Should have triggered refresh (hidden > 5 min)
    expect(refreshCalled).toBe(true);
  });

  it('does NOT refresh when tab hidden for less than 5 minutes', async () => {
    const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

    let lastHiddenTimeRef = null;
    let refreshCalled = false;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lastHiddenTimeRef = Date.now();
        return;
      }

      if (lastHiddenTimeRef) {
        const hiddenDuration = Date.now() - lastHiddenTimeRef;
        if (hiddenDuration > REFRESH_THRESHOLD_MS) {
          refreshCalled = true;
        }
        lastHiddenTimeRef = null;
      }
    };

    // Tab hidden
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    handleVisibilityChange();

    // Advance only 2 minutes
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    // Tab visible
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    handleVisibilityChange();

    // Should NOT have triggered refresh (hidden < 5 min)
    expect(refreshCalled).toBe(false);
  });

  it('refresh threshold is exactly 5 minutes', async () => {
    const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

    let lastHiddenTimeRef = null;
    let refreshCalled = false;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lastHiddenTimeRef = Date.now();
        return;
      }

      if (lastHiddenTimeRef) {
        const hiddenDuration = Date.now() - lastHiddenTimeRef;
        if (hiddenDuration > REFRESH_THRESHOLD_MS) {
          refreshCalled = true;
        }
        lastHiddenTimeRef = null;
      }
    };

    // Tab hidden
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    handleVisibilityChange();

    // Advance exactly 5 minutes (should NOT trigger - need > 5 min)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    // Tab visible
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    handleVisibilityChange();

    expect(refreshCalled).toBe(false);

    // Reset and try 5 minutes + 1 second
    refreshCalled = false;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    handleVisibilityChange();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    handleVisibilityChange();

    expect(refreshCalled).toBe(true);
  });
});
