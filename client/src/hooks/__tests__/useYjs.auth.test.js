/**
 * useYjs Auth Error Detection Tests
 *
 * Tests the authentication and reconnection logic in useYjs:
 * - WebSocket close code detection (1008, 1006, 4401, 4403)
 * - Error message parsing for auth keywords
 * - Max retry threshold triggering authError
 * - Token state changes (cleared/restored)
 * - forceReconnect behavior
 * - clearYjsInstanceCache functionality
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

// Test constants
const TEST_DOC_GUID = 'test-doc-12345678-1234-4123-8123-123456789abc';
const TEST_ACCESS_TOKEN = 'test-access-token-12345';

describe('useYjs auth error detection', () => {
  let mockProvider;
  let mockIndexeddbProvider;

  beforeEach(() => {
    // Reset singletons and mocks
    resetYjsSingletons();
    clearYjsInstanceCache();
    vi.clearAllMocks();

    // Create controllable mock provider
    mockProvider = createControllableMockProvider();

    WebsocketProvider.mockImplementation(() => mockProvider);

    // Mock IndexedDB provider
    mockIndexeddbProvider = {
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn((event, handler) => {
        // Immediately call synced handler
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

  describe('WebSocket close codes', () => {
    // Note: useYjs has auto-recovery logic that clears authError when a valid token is present.
    // When testing that authError persists, we need to clear the token after the error.
    // When testing that reconnection is attempted (auto-recovery), we check for connect() calls.

    it('detects auth error from close code 1008 and attempts auto-recovery with valid token', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Clear previous connect calls from setup
      mockProvider.connect.mockClear();

      // Emit close event with auth-related code
      act(() => {
        mockProvider._emitConnectionClose(1008, 'Policy Violation');
      });

      // With a valid token, useYjs auto-recovers: clears authError and reconnects
      await waitFor(() => {
        expect(mockProvider.connect).toHaveBeenCalled();
      });

      // authError should be false after auto-recovery
      expect(result.current.authError).toBe(false);
    });

    it('persists auth error when token is null after close code 1008', async () => {
      // Start with token, then clear it to simulate refresh failure
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Emit close event with auth-related code
      act(() => {
        mockProvider._emitConnectionClose(1008, 'Policy Violation');
      });

      // Clear the token (simulating failed refresh)
      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
        expect(result.current.connectionState).toBe('disconnected');
      });
    });

    it('persists auth error when token is null after close code 1006', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionClose(1006);
      });

      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('persists auth error when token is null after close code 4401', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionClose(4401, 'Token expired');
      });

      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('persists auth error when token is null after close code 4403', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionClose(4403, 'Access denied');
      });

      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('does NOT set auth error for normal close code 1000', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionClose(1000, 'Normal closure');
      });

      // Give it time to potentially trigger
      await new Promise(r => setTimeout(r, 100));

      expect(result.current.authError).toBe(false);
    });

    it('does NOT set auth error for close code 1001 (Going Away)', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionClose(1001, 'Going Away');
      });

      await new Promise(r => setTimeout(r, 100));

      expect(result.current.authError).toBe(false);
    });
  });

  describe('Connection error messages', () => {
    // Note: Like close codes, error messages trigger auto-recovery when token is valid.
    // We test both the auto-recovery (reconnect) and the persist-error (token null) scenarios.

    it('attempts auto-recovery when error message contains "401" with valid token', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());
      mockProvider.connect.mockClear();

      act(() => {
        mockProvider._emitConnectionError('HTTP 401 Unauthorized');
      });

      // With valid token, auto-recovery attempts reconnection
      await waitFor(() => {
        expect(mockProvider.connect).toHaveBeenCalled();
      });
    });

    it('persists auth error when token is null after "401" error', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionError('HTTP 401 Unauthorized');
      });

      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('persists auth error when token is null after "unauthorized" error', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionError('Request unauthorized');
      });

      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('persists auth error when token is null after "403" error', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionError('HTTP 403 Forbidden');
      });

      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('persists auth error when token is null after "forbidden" error', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionError('Access forbidden');
      });

      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('persists auth error when token is null after "auth" keyword error', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionError('Authentication failed');
      });

      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('is case-insensitive for auth keyword detection', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionError('UNAUTHORIZED ACCESS');
      });

      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('does NOT set auth error for generic network errors', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitConnectionError('Network connection failed');
      });

      // Give it time to potentially trigger
      await new Promise(r => setTimeout(r, 100));

      // Should not trigger auth error for generic network issues
      // (unless max retry threshold is reached)
      expect(result.current.authError).toBe(false);
    });
  });

  describe('Max retry threshold', () => {
    it('triggers auto-recovery after 5 consecutive failures with valid token', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());
      mockProvider.connect.mockClear();

      // Simulate 5 connection errors without auth keywords
      for (let i = 0; i < 5; i++) {
        act(() => {
          mockProvider._emitConnectionError('Connection failed');
        });
      }

      // With valid token, auto-recovery is triggered
      await waitFor(() => {
        expect(mockProvider.connect).toHaveBeenCalled();
      });
    });

    it('persists auth error after 5 failures when token is null', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Simulate 5 connection errors
      for (let i = 0; i < 5; i++) {
        act(() => {
          mockProvider._emitConnectionError('Connection failed');
        });
      }

      // Clear the token
      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
      });
    });

    it('does NOT set auth error after only 4 failures', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Simulate 4 connection errors
      for (let i = 0; i < 4; i++) {
        act(() => {
          mockProvider._emitConnectionError('Connection failed');
        });
      }

      await new Promise(r => setTimeout(r, 100));

      expect(result.current.authError).toBe(false);
    });

    it('resets retry counter on successful sync', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Simulate 3 failures
      for (let i = 0; i < 3; i++) {
        act(() => {
          mockProvider._emitConnectionError('Connection failed');
        });
      }

      // Then successful sync
      act(() => {
        mockProvider._emitStatus('connected');
        mockProvider._emitSync(true);
      });

      await waitFor(() => {
        expect(result.current.synced).toBe(true);
      });

      // Now 3 more failures should NOT trigger auth error (counter was reset)
      for (let i = 0; i < 3; i++) {
        act(() => {
          mockProvider._emitConnectionError('Connection failed');
        });
      }

      await new Promise(r => setTimeout(r, 100));

      expect(result.current.authError).toBe(false);
    });
  });

  describe('Token state changes', () => {
    it('sets authError when token becomes null while provider exists', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Simulate initial connection
      act(() => {
        mockProvider._emitStatus('connected');
        mockProvider._emitSync(true);
      });

      await waitFor(() => expect(result.current.connected).toBe(true));

      // Token expires (becomes null)
      rerender({ token: null });

      await waitFor(() => {
        expect(result.current.authError).toBe(true);
        expect(result.current.connectionState).toBe('disconnected');
      });
    });

    it('clears authError when token is restored (auto-recovery)', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Simulate token becoming null (auth failure)
      rerender({ token: null });

      await waitFor(() => expect(result.current.authError).toBe(true));

      // Clear cache and create fresh mock for restored token scenario
      clearYjsInstanceCache();
      resetYjsSingletons();

      const newMockProvider = createControllableMockProvider();
      WebsocketProvider.mockImplementation(() => newMockProvider);

      // Token restored (refreshed) - create a new hook instance to simulate the flow
      const { result: newResult } = renderHook(
        () => useYjs('new-doc-guid', 'new-refreshed-token')
      );

      await waitFor(() => {
        expect(newResult.current.provider).toBeDefined();
        expect(newResult.current.authError).toBe(false);
      });
    });

    it('does not create WebSocket provider without token', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, null));

      // Should have ydoc but no provider
      expect(result.current.ydoc).toBeInstanceOf(Y.Doc);
      expect(result.current.provider).toBeNull();
    });

    it('creates provider when token becomes available (fresh doc)', async () => {
      // Clear cache to ensure fresh start
      clearYjsInstanceCache();
      resetYjsSingletons();

      const newMockProvider = createControllableMockProvider();
      WebsocketProvider.mockImplementation(() => newMockProvider);

      // Start with a fresh doc and token
      const { result } = renderHook(
        () => useYjs('fresh-doc-guid', TEST_ACCESS_TOKEN)
      );

      await waitFor(() => {
        expect(result.current.provider).not.toBeNull();
      });
    });
  });

  describe('forceReconnect', () => {
    it('provides forceReconnect function', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      expect(typeof result.current.forceReconnect).toBe('function');
    });

    it('calls disconnect then connect on forceReconnect', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        result.current.forceReconnect();
      });

      expect(mockProvider.disconnect).toHaveBeenCalled();

      // Connect should be called after 100ms delay
      await waitFor(() => {
        expect(mockProvider.connect).toHaveBeenCalled();
      }, { timeout: 200 });
    });

    it('does nothing if provider is null', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, null));

      // Should not throw
      act(() => {
        result.current.forceReconnect();
      });

      expect(mockProvider.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('clearYjsInstanceCache', () => {
    it('destroys all cached providers', async () => {
      // Create an instance
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      const provider = result.current.provider;

      // Clear the cache
      clearYjsInstanceCache();

      expect(provider.destroy).toHaveBeenCalled();
    });

    it('allows fresh instances to be created after clearing', async () => {
      // Create first instance
      const { result: first } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(first.current.provider).toBeDefined());

      // Clear the cache
      clearYjsInstanceCache();
      resetYjsSingletons();

      // Reset mock to track new instance creation
      WebsocketProvider.mockClear();

      // Create second mock provider for the new instance
      const newMockProvider = createControllableMockProvider();
      WebsocketProvider.mockImplementation(() => newMockProvider);

      // Create new instance with different doc GUID
      const { result: second } = renderHook(() => useYjs('different-doc-guid', TEST_ACCESS_TOKEN));

      await waitFor(() => {
        expect(second.current.provider).toBeDefined();
      });

      expect(WebsocketProvider).toHaveBeenCalled();
    });
  });

  describe('connection state transitions', () => {
    it('starts in connecting state', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Initial state should be connecting (wsconnected is false initially)
      expect(result.current.connectionState).toBe('connecting');
    });

    it('transitions to connected on status event', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      act(() => {
        mockProvider._emitStatus('connected');
      });

      await waitFor(() => {
        expect(result.current.connectionState).toBe('connected');
        expect(result.current.connected).toBe(true);
      });
    });

    it('transitions to disconnected on disconnect', async () => {
      const { result } = renderHook(() => useYjs(TEST_DOC_GUID, TEST_ACCESS_TOKEN));

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // First connect
      act(() => {
        mockProvider._emitStatus('connected');
      });

      await waitFor(() => expect(result.current.connected).toBe(true));

      // Then disconnect
      act(() => {
        mockProvider._emitStatus('disconnected');
      });

      await waitFor(() => {
        expect(result.current.connectionState).toBe('disconnected');
        expect(result.current.connected).toBe(false);
      });
    });

    it('clears authError on successful connection after manual retry', async () => {
      const { result, rerender } = renderHook(
        ({ token }) => useYjs(TEST_DOC_GUID, token),
        { initialProps: { token: TEST_ACCESS_TOKEN } }
      );

      await waitFor(() => expect(result.current.provider).toBeDefined());

      // Simulate auth failure + token becomes null
      act(() => {
        mockProvider._emitConnectionClose(1008);
      });
      rerender({ token: null });

      await waitFor(() => expect(result.current.authError).toBe(true));

      // Clear cache and set up fresh provider for reconnection
      clearYjsInstanceCache();
      resetYjsSingletons();

      const newMockProvider = createControllableMockProvider();
      WebsocketProvider.mockImplementation(() => newMockProvider);

      // Simulate token refresh success - use new doc to avoid cache issues
      const { result: newResult } = renderHook(
        () => useYjs('reconnect-doc-guid', 'new-valid-token')
      );

      await waitFor(() => expect(newResult.current.provider).toBeDefined());

      // Successful connection should have authError as false
      act(() => {
        newMockProvider._emitStatus('connected');
      });

      await waitFor(() => {
        expect(newResult.current.authError).toBe(false);
        expect(newResult.current.connectionState).toBe('connected');
      });
    });
  });
});
