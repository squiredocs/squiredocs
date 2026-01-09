/**
 * EditorView Banner State Tests
 *
 * Tests the banner rendering logic in EditorView:
 * - Auth error banner (Session expired)
 * - Disconnected banner (Offline + Retry button)
 * - Connecting banner (with reconnect count)
 * - Syncing banner
 * - No banner (happy path)
 * - State transitions (anti-stuck tests)
 * - Auth redirect behavior
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import * as Y from 'yjs';
import EditorView from '../EditorView';
import { useYjs } from '../../hooks/useYjs';
import { useAuth } from '../../contexts/AuthContext';
import { useVersionHistory } from '../../hooks/useVersionHistory';
import { useMobile } from '../../hooks/useMobile';
import { useVisualViewport } from '../../hooks/useVisualViewport';
import { createControllableMockProvider, createMockAuthContext } from '../../test/utils';

// Mock all hooks
vi.mock('../../hooks/useYjs');
vi.mock('../../contexts/AuthContext');
vi.mock('../../hooks/useVersionHistory');
vi.mock('../../hooks/useMobile');
vi.mock('../../hooks/useVisualViewport');

// Mock Editor component (complex, not needed for banner tests)
vi.mock('../Editor', () => ({
  default: () => <div data-testid="mock-editor">Editor</div>
}));

// Mock other components
vi.mock('../Toolbar', () => ({
  default: () => <div data-testid="mock-toolbar">Toolbar</div>
}));

vi.mock('../MobileActionBar', () => ({
  default: () => null
}));

vi.mock('../UserProfileBadge', () => ({
  default: () => <div data-testid="mock-user-badge">User Badge</div>
}));

vi.mock('../ShareDialog', () => ({
  default: () => null
}));

vi.mock('../VersionHistoryPanel', () => ({
  default: () => null
}));

vi.mock('../VersionPreview', () => ({
  default: () => null
}));

// Test constants
const TEST_DOC_GUID = 'test-doc-guid-12345';

describe('EditorView banner states', () => {
  let mockProvider;
  let mockYdoc;
  let defaultYjsReturn;
  let defaultAuthReturn;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mocks
    mockProvider = createControllableMockProvider();
    mockYdoc = new Y.Doc();

    // Default useYjs return value (connected and synced - no banner)
    defaultYjsReturn = {
      ydoc: mockYdoc,
      provider: mockProvider,
      awareness: mockProvider.awareness,
      connected: true,
      connectionState: 'connected',
      synced: true,
      users: [],
      docGuid: TEST_DOC_GUID,
      docTitle: 'Test Document',
      setDocTitle: vi.fn(),
      forceReconnect: vi.fn(),
      reconnectCount: 0,
      authError: false
    };

    // Default useAuth return value
    defaultAuthReturn = createMockAuthContext();

    vi.mocked(useYjs).mockReturnValue(defaultYjsReturn);
    vi.mocked(useAuth).mockReturnValue(defaultAuthReturn);

    // Mock version history
    vi.mocked(useVersionHistory).mockReturnValue({
      versions: [],
      groupedVersions: [],
      selectedVersion: null,
      versionContent: null,
      totalEdits: 0,
      isLoading: false,
      selectVersion: vi.fn(),
      restoreVersion: vi.fn(),
      createNamedVersion: vi.fn(),
      renameVersion: vi.fn(),
      deleteNamedVersion: vi.fn(),
      clearSelection: vi.fn()
    });

    // Mock mobile and viewport
    vi.mocked(useMobile).mockReturnValue(false);
    vi.mocked(useVisualViewport).mockReturnValue({ height: 800, offsetTop: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper to render EditorView with default props
  const renderEditorView = (yjsOverrides = {}, authOverrides = {}) => {
    vi.mocked(useYjs).mockReturnValue({ ...defaultYjsReturn, ...yjsOverrides });
    vi.mocked(useAuth).mockReturnValue({ ...defaultAuthReturn, ...authOverrides });

    return render(
      <EditorView
        docGuid={TEST_DOC_GUID}
        onNavigateHome={vi.fn()}
        onNavigateToVersions={vi.fn()}
        onNavigateToSettings={vi.fn()}
        user={{ id: 'user-1', name: 'Test User', email: 'test@example.com' }}
      />
    );
  };

  describe('Auth error banner', () => {
    it('shows "Connection failed" with Retry when authError is true and authenticated', () => {
      renderEditorView({ authError: true, connectionState: 'disconnected' });

      expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('shows "Session expired" when authError is true and NOT authenticated', () => {
      renderEditorView(
        { authError: true, connectionState: 'disconnected' },
        { isAuthenticated: false, accessToken: null }
      );

      expect(screen.getByText(/Session expired/)).toBeInTheDocument();
    });

    it('auth error banner has correct styling', () => {
      renderEditorView({ authError: true, connectionState: 'disconnected' });

      const banner = screen.getByText(/Connection failed/).closest('.sync-banner');
      expect(banner).toHaveClass('sync-banner--error');
    });

    it('does NOT show other banners when authError is true', () => {
      renderEditorView({
        authError: true,
        connectionState: 'disconnected',
        synced: false
      });

      expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
      expect(screen.queryByText('Offline')).not.toBeInTheDocument();
      expect(screen.queryByText(/Connecting/)).not.toBeInTheDocument();
      expect(screen.queryByText('Syncing...')).not.toBeInTheDocument();
    });
  });

  describe('Disconnected banner', () => {
    it('shows "Offline" when disconnected and no auth error', () => {
      renderEditorView({
        connectionState: 'disconnected',
        connected: false,
        authError: false
      });

      expect(screen.getByText('Offline')).toBeInTheDocument();
    });

    it('shows Retry button when disconnected', () => {
      renderEditorView({
        connectionState: 'disconnected',
        connected: false,
        authError: false
      });

      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('Retry button calls forceReconnect', () => {
      const forceReconnect = vi.fn();
      renderEditorView({
        connectionState: 'disconnected',
        connected: false,
        authError: false,
        forceReconnect
      });

      const retryBtn = screen.getByText('Retry');
      fireEvent.click(retryBtn);

      expect(forceReconnect).toHaveBeenCalled();
    });

    it('does NOT show disconnected banner when authError is true', () => {
      renderEditorView({
        connectionState: 'disconnected',
        connected: false,
        authError: true
      });

      expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    });
  });

  describe('Connecting banner', () => {
    it('shows "Connecting..." on initial connection', () => {
      renderEditorView({
        connectionState: 'connecting',
        connected: false,
        reconnectCount: 0,
        authError: false
      });

      expect(screen.getByText('Connecting...')).toBeInTheDocument();
    });

    it('shows "Reconnecting... (N)" on subsequent attempts', () => {
      renderEditorView({
        connectionState: 'connecting',
        connected: false,
        reconnectCount: 3,
        authError: false
      });

      expect(screen.getByText('Reconnecting... (3)')).toBeInTheDocument();
    });

    it('shows "Reconnecting... (5)" for high reconnect counts', () => {
      renderEditorView({
        connectionState: 'connecting',
        connected: false,
        reconnectCount: 5,
        authError: false
      });

      expect(screen.getByText('Reconnecting... (5)')).toBeInTheDocument();
    });

    it('does NOT show connecting banner when authError is true', () => {
      renderEditorView({
        connectionState: 'connecting',
        authError: true
      });

      expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
      expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
    });
  });

  describe('Syncing banner', () => {
    it('shows "Syncing..." when connected but not synced', () => {
      renderEditorView({
        connectionState: 'connected',
        connected: true,
        synced: false,
        authError: false
      });

      expect(screen.getByText('Syncing...')).toBeInTheDocument();
    });

    it('does NOT show syncing banner when synced', () => {
      renderEditorView({
        connectionState: 'connected',
        connected: true,
        synced: true,
        authError: false
      });

      expect(screen.queryByText('Syncing...')).not.toBeInTheDocument();
    });

    it('does NOT show syncing banner when authError is true', () => {
      renderEditorView({
        connectionState: 'connected',
        connected: true,
        synced: false,
        authError: true
      });

      expect(screen.queryByText('Syncing...')).not.toBeInTheDocument();
    });
  });

  describe('No banner (happy path)', () => {
    it('shows no banner when connected and synced', () => {
      renderEditorView({
        connectionState: 'connected',
        connected: true,
        synced: true,
        authError: false
      });

      expect(screen.queryByText('Offline')).not.toBeInTheDocument();
      expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
      expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
      expect(screen.queryByText('Syncing...')).not.toBeInTheDocument();
      expect(screen.queryByText(/Session expired/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Connection failed/)).not.toBeInTheDocument();
    });
  });

  describe('Banner state transitions (anti-stuck tests)', () => {
    it('transitions from connecting to connected correctly', async () => {
      const { rerender } = renderEditorView({
        connectionState: 'connecting',
        connected: false,
        authError: false
      });

      expect(screen.getByText('Connecting...')).toBeInTheDocument();

      // Simulate connection success
      vi.mocked(useYjs).mockReturnValue({
        ...defaultYjsReturn,
        connectionState: 'connected',
        connected: true,
        synced: true
      });

      rerender(
        <EditorView
          docGuid={TEST_DOC_GUID}
          onNavigateHome={vi.fn()}
          onNavigateToVersions={vi.fn()}
          onNavigateToSettings={vi.fn()}
          user={{ id: 'user-1', name: 'Test User', email: 'test@example.com' }}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
      });
    });

    it('transitions from disconnected to connected after retry', async () => {
      const { rerender } = renderEditorView({
        connectionState: 'disconnected',
        connected: false,
        authError: false
      });

      expect(screen.getByText('Offline')).toBeInTheDocument();

      // Simulate successful reconnection
      vi.mocked(useYjs).mockReturnValue({
        ...defaultYjsReturn,
        connectionState: 'connected',
        connected: true,
        synced: true
      });

      rerender(
        <EditorView
          docGuid={TEST_DOC_GUID}
          onNavigateHome={vi.fn()}
          onNavigateToVersions={vi.fn()}
          onNavigateToSettings={vi.fn()}
          user={{ id: 'user-1', name: 'Test User', email: 'test@example.com' }}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Offline')).not.toBeInTheDocument();
      });
    });

    it('transitions from syncing to synced correctly', async () => {
      const { rerender } = renderEditorView({
        connectionState: 'connected',
        connected: true,
        synced: false,
        authError: false
      });

      expect(screen.getByText('Syncing...')).toBeInTheDocument();

      // Simulate sync complete
      vi.mocked(useYjs).mockReturnValue({
        ...defaultYjsReturn,
        connectionState: 'connected',
        connected: true,
        synced: true
      });

      rerender(
        <EditorView
          docGuid={TEST_DOC_GUID}
          onNavigateHome={vi.fn()}
          onNavigateToVersions={vi.fn()}
          onNavigateToSettings={vi.fn()}
          user={{ id: 'user-1', name: 'Test User', email: 'test@example.com' }}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Syncing...')).not.toBeInTheDocument();
      });
    });

    it('transitions from authError to connected after retry', async () => {
      const { rerender } = renderEditorView({
        authError: true,
        connectionState: 'disconnected'
      });

      expect(screen.getByText(/Connection failed/)).toBeInTheDocument();

      // Simulate reconnect success
      vi.mocked(useYjs).mockReturnValue({
        ...defaultYjsReturn,
        authError: false,
        connectionState: 'connected',
        connected: true,
        synced: true
      });

      rerender(
        <EditorView
          docGuid={TEST_DOC_GUID}
          onNavigateHome={vi.fn()}
          onNavigateToVersions={vi.fn()}
          onNavigateToSettings={vi.fn()}
          user={{ id: 'user-1', name: 'Test User', email: 'test@example.com' }}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText(/Connection failed/)).not.toBeInTheDocument();
      });
    });
  });

  describe('Auth redirect', () => {
    let originalLocation;

    beforeEach(() => {
      originalLocation = window.location;
      delete window.location;
      window.location = { href: '', pathname: '/docs/test' };
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      window.location = originalLocation;
    });

    it('redirects to /login when authError and not authenticated', async () => {
      renderEditorView(
        { authError: true, connectionState: 'disconnected' },
        { isAuthenticated: false, accessToken: null, user: null }
      );

      // Advance past the 2 second delay
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });

      expect(window.location.href).toContain('/login');
    });

    it('does NOT redirect immediately (has delay)', async () => {
      renderEditorView(
        { authError: true, connectionState: 'disconnected' },
        { isAuthenticated: false, accessToken: null, user: null }
      );

      // Before delay
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(window.location.href).not.toContain('/login');
    });

    it('does NOT redirect if still authenticated', async () => {
      renderEditorView(
        { authError: true, connectionState: 'disconnected' },
        { isAuthenticated: true } // Still authenticated
      );

      // Even after the redirect delay, should NOT redirect if still authenticated
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });

      expect(window.location.href).not.toContain('/login');
    });
  });

  describe('Banner priority', () => {
    it('authError takes priority over disconnected', () => {
      renderEditorView({
        authError: true,
        connectionState: 'disconnected',
        connected: false
      });

      expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
      expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    });

    it('authError takes priority over connecting', () => {
      renderEditorView({
        authError: true,
        connectionState: 'connecting',
        connected: false
      });

      expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
      expect(screen.queryByText(/Connecting/)).not.toBeInTheDocument();
    });

    it('authError takes priority over syncing', () => {
      renderEditorView({
        authError: true,
        connectionState: 'connected',
        connected: true,
        synced: false
      });

      expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
      expect(screen.queryByText('Syncing...')).not.toBeInTheDocument();
    });
  });
});
