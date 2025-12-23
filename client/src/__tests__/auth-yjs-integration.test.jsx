/**
 * Auth + YJS Integration Tests
 *
 * Tests the interaction between authentication state and WebSocket connection.
 * These tests use mocked useYjs to verify UI behavior without real WebSocket connections.
 *
 * For real WebSocket connection testing, see:
 * - hooks/__tests__/useYjs.auth.test.js: Auth error detection from WS events
 * - components/__tests__/EditorView.banners.test.jsx: Banner rendering based on state
 *
 * This file tests the component-level integration of auth + yjs states.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import * as Y from 'yjs';
import { useYjs, clearYjsInstanceCache } from '../hooks/useYjs';
import { useAuth } from '../contexts/AuthContext';
import { createControllableMockProvider } from '../test/utils';

// Mock hooks
vi.mock('../hooks/useYjs');
vi.mock('../contexts/AuthContext');

/**
 * Simplified test component that displays connection state
 */
function TestConnectionDisplay() {
  const auth = useAuth();
  const yjs = useYjs('test-doc', auth?.accessToken);

  return (
    <div>
      <span data-testid="connection-state">{yjs?.connectionState || 'unknown'}</span>
      <span data-testid="synced">{yjs?.synced ? 'yes' : 'no'}</span>
      <span data-testid="auth-error">{yjs?.authError ? 'yes' : 'no'}</span>
      <span data-testid="authenticated">{auth?.isAuthenticated ? 'yes' : 'no'}</span>
      <span data-testid="reconnect-count">{yjs?.reconnectCount || 0}</span>

      {yjs?.authError && (
        <div data-testid="auth-error-banner">
          Session expired
        </div>
      )}

      {!yjs?.authError && yjs?.connectionState === 'disconnected' && (
        <div data-testid="offline-banner">
          Offline
          <button data-testid="retry-btn" onClick={yjs?.forceReconnect}>Retry</button>
        </div>
      )}

      {!yjs?.authError && yjs?.connectionState === 'connecting' && (
        <div data-testid="connecting-banner">
          {yjs?.reconnectCount > 0 ? `Reconnecting... (${yjs.reconnectCount})` : 'Connecting...'}
        </div>
      )}

      {!yjs?.authError && yjs?.connectionState === 'connected' && !yjs?.synced && (
        <div data-testid="syncing-banner">Syncing...</div>
      )}
    </div>
  );
}

describe('Auth + YJS Integration', () => {
  let mockProvider;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = createControllableMockProvider();

    // Default auth state - authenticated
    vi.mocked(useAuth).mockReturnValue({
      user: { id: 'user-1', name: 'Test User', email: 'test@example.com' },
      accessToken: 'test-token',
      isAuthenticated: true,
      loading: false,
      error: null,
      login: vi.fn(),
      logout: vi.fn(),
      api: {},
      expireTokenForTesting: vi.fn()
    });

    // Default yjs state - connected and synced
    vi.mocked(useYjs).mockReturnValue({
      ydoc: new Y.Doc(),
      provider: mockProvider,
      awareness: mockProvider.awareness,
      connected: true,
      connectionState: 'connected',
      synced: true,
      users: [],
      docGuid: 'test-doc',
      docTitle: 'Test Document',
      setDocTitle: vi.fn(),
      forceReconnect: vi.fn(),
      reconnectCount: 0,
      authError: false
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Banner visibility based on state', () => {
    it('shows no banner when connected and synced', () => {
      render(<TestConnectionDisplay />);

      expect(screen.queryByTestId('auth-error-banner')).not.toBeInTheDocument();
      expect(screen.queryByTestId('offline-banner')).not.toBeInTheDocument();
      expect(screen.queryByTestId('connecting-banner')).not.toBeInTheDocument();
      expect(screen.queryByTestId('syncing-banner')).not.toBeInTheDocument();
    });

    it('shows auth error banner when authError is true', () => {
      vi.mocked(useYjs).mockReturnValue({
        ...vi.mocked(useYjs)(),
        authError: true,
        connectionState: 'disconnected'
      });

      render(<TestConnectionDisplay />);

      expect(screen.getByTestId('auth-error-banner')).toBeInTheDocument();
      expect(screen.queryByTestId('offline-banner')).not.toBeInTheDocument();
    });

    it('shows offline banner when disconnected without auth error', () => {
      vi.mocked(useYjs).mockReturnValue({
        ...vi.mocked(useYjs)(),
        connectionState: 'disconnected',
        connected: false,
        authError: false
      });

      render(<TestConnectionDisplay />);

      expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('shows connecting banner during initial connection', () => {
      vi.mocked(useYjs).mockReturnValue({
        ...vi.mocked(useYjs)(),
        connectionState: 'connecting',
        connected: false,
        synced: false,
        reconnectCount: 0,
        authError: false
      });

      render(<TestConnectionDisplay />);

      expect(screen.getByText('Connecting...')).toBeInTheDocument();
    });

    it('shows reconnecting banner with count', () => {
      vi.mocked(useYjs).mockReturnValue({
        ...vi.mocked(useYjs)(),
        connectionState: 'connecting',
        connected: false,
        synced: false,
        reconnectCount: 3,
        authError: false
      });

      render(<TestConnectionDisplay />);

      expect(screen.getByText('Reconnecting... (3)')).toBeInTheDocument();
    });

    it('shows syncing banner when connected but not synced', () => {
      vi.mocked(useYjs).mockReturnValue({
        ...vi.mocked(useYjs)(),
        connectionState: 'connected',
        connected: true,
        synced: false,
        authError: false
      });

      render(<TestConnectionDisplay />);

      expect(screen.getByTestId('syncing-banner')).toBeInTheDocument();
    });
  });

  describe('Retry functionality', () => {
    it('calls forceReconnect when retry button is clicked', () => {
      const forceReconnect = vi.fn();

      vi.mocked(useYjs).mockReturnValue({
        ...vi.mocked(useYjs)(),
        connectionState: 'disconnected',
        connected: false,
        authError: false,
        forceReconnect
      });

      render(<TestConnectionDisplay />);

      fireEvent.click(screen.getByTestId('retry-btn'));

      expect(forceReconnect).toHaveBeenCalled();
    });
  });

  describe('State transitions', () => {
    it('auth error banner takes priority over offline banner', () => {
      vi.mocked(useYjs).mockReturnValue({
        ...vi.mocked(useYjs)(),
        connectionState: 'disconnected',
        connected: false,
        authError: true
      });

      render(<TestConnectionDisplay />);

      expect(screen.getByTestId('auth-error-banner')).toBeInTheDocument();
      expect(screen.queryByTestId('offline-banner')).not.toBeInTheDocument();
    });

    it('updates display when connection state changes', () => {
      const { rerender } = render(<TestConnectionDisplay />);

      // Initially connected
      expect(screen.getByTestId('connection-state').textContent).toBe('connected');

      // Update to disconnected
      vi.mocked(useYjs).mockReturnValue({
        ...vi.mocked(useYjs)(),
        connectionState: 'disconnected',
        connected: false,
        authError: false
      });

      rerender(<TestConnectionDisplay />);

      expect(screen.getByTestId('connection-state').textContent).toBe('disconnected');
      expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
    });
  });

  describe('Authentication state integration', () => {
    it('displays authenticated state correctly', () => {
      render(<TestConnectionDisplay />);

      expect(screen.getByTestId('authenticated').textContent).toBe('yes');
    });

    it('displays unauthenticated state when token is cleared', () => {
      vi.mocked(useAuth).mockReturnValue({
        ...vi.mocked(useAuth)(),
        accessToken: null,
        user: null,
        isAuthenticated: false
      });

      render(<TestConnectionDisplay />);

      expect(screen.getByTestId('authenticated').textContent).toBe('no');
    });
  });
});
