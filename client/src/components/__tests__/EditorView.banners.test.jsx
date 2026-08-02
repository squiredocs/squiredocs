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
import { createControllableMockProvider, createMockAuthContext } from '../../test/utils';

// Mock all hooks
vi.mock('../../hooks/useYjs');
vi.mock('../../contexts/AuthContext');
vi.mock('../../hooks/useVersionHistory');
vi.mock('../../hooks/useMobile');

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

// Banner debounce delay in EditorView
const BANNER_DEBOUNCE_MS = 500;

describe('EditorView banner states', () => {
  let mockProvider;
  let mockYdoc;
  let defaultYjsReturn;
  let defaultAuthReturn;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

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
      totalEdits: 0,
      isLoading: false,
      selectVersion: vi.fn(),
      restoreVersion: vi.fn(),
      createNamedVersion: vi.fn(),
      renameVersion: vi.fn(),
      deleteNamedVersion: vi.fn(),
    });

    // Mock mobile
    vi.mocked(useMobile).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Helper to render EditorView with default props and advance past debounce
  const renderEditorView = async (yjsOverrides = {}, authOverrides = {}) => {
    vi.mocked(useYjs).mockReturnValue({ ...defaultYjsReturn, ...yjsOverrides });
    vi.mocked(useAuth).mockReturnValue({ ...defaultAuthReturn, ...authOverrides });

    const result = render(
      <EditorView
        docGuid={TEST_DOC_GUID}
        onNavigateHome={vi.fn()}
        onNavigateToVersions={vi.fn()}
        onNavigateToSettings={vi.fn()}
        user={{ id: 'user-1', name: 'Test User', email: 'test@example.com' }}
        aiPanel={{ isOpen: false, toggle: vi.fn(), focusPopup: vi.fn(), isPoppedOut: false, position: 'right' }}
      />
    );

    // Advance past banner debounce
    await act(async () => {
      vi.advanceTimersByTime(BANNER_DEBOUNCE_MS);
    });

    return result;
  };

  describe('Auth error banner', () => {
    it('shows "Connection failed" with Retry when authError is true and authenticated', async () => {
      await renderEditorView({ authError: true, connectionState: 'disconnected' });

      expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('shows "Session expired" when authError is true and NOT authenticated', async () => {
      await renderEditorView(
        { authError: true, connectionState: 'disconnected' },
        { isAuthenticated: false, accessToken: null }
      );

      expect(screen.getByText(/Session expired/)).toBeInTheDocument();
    });

    it('auth error banner has correct styling', async () => {
      await renderEditorView({ authError: true, connectionState: 'disconnected' });

      const banner = screen.getByText(/Connection failed/).closest('.sync-banner');
      expect(banner).toHaveClass('sync-banner--error');
    });

    it('does NOT show other banners when authError is true', async () => {
      await renderEditorView({
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
    it('shows "Offline" when disconnected and no auth error', async () => {
      await renderEditorView({
        connectionState: 'disconnected',
        connected: false,
        authError: false
      });

      expect(screen.getByText('Offline')).toBeInTheDocument();
    });

    it('shows Retry button when disconnected', async () => {
      await renderEditorView({
        connectionState: 'disconnected',
        connected: false,
        authError: false
      });

      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('Retry button calls forceReconnect', async () => {
      const forceReconnect = vi.fn();
      await renderEditorView({
        connectionState: 'disconnected',
        connected: false,
        authError: false,
        forceReconnect
      });

      const retryBtn = screen.getByText('Retry');
      fireEvent.click(retryBtn);

      expect(forceReconnect).toHaveBeenCalled();
    });

    it('does NOT show disconnected banner when authError is true', async () => {
      await renderEditorView({
        connectionState: 'disconnected',
        connected: false,
        authError: true
      });

      expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    });
  });

  describe('Connecting banner', () => {
    it('shows "Connecting..." on initial connection', async () => {
      await renderEditorView({
        connectionState: 'connecting',
        connected: false,
        reconnectCount: 0,
        authError: false
      });

      expect(screen.getByText('Connecting...')).toBeInTheDocument();
    });

    it('shows "Reconnecting... (N)" on subsequent attempts', async () => {
      await renderEditorView({
        connectionState: 'connecting',
        connected: false,
        reconnectCount: 3,
        authError: false
      });

      expect(screen.getByText('Reconnecting... (3)')).toBeInTheDocument();
    });

    it('shows "Reconnecting... (5)" for high reconnect counts', async () => {
      await renderEditorView({
        connectionState: 'connecting',
        connected: false,
        reconnectCount: 5,
        authError: false
      });

      expect(screen.getByText('Reconnecting... (5)')).toBeInTheDocument();
    });

    it('does NOT show connecting banner when authError is true', async () => {
      await renderEditorView({
        connectionState: 'connecting',
        authError: true
      });

      expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
      expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
    });
  });

  describe('Syncing banner', () => {
    it('shows "Syncing..." when connected but not synced', async () => {
      await renderEditorView({
        connectionState: 'connected',
        connected: true,
        synced: false,
        authError: false
      });

      expect(screen.getByText('Syncing...')).toBeInTheDocument();
    });

    it('does NOT show syncing banner when synced', async () => {
      await renderEditorView({
        connectionState: 'connected',
        connected: true,
        synced: true,
        authError: false
      });

      expect(screen.queryByText('Syncing...')).not.toBeInTheDocument();
    });

    it('does NOT show syncing banner when authError is true', async () => {
      await renderEditorView({
        connectionState: 'connected',
        connected: true,
        synced: false,
        authError: true
      });

      expect(screen.queryByText('Syncing...')).not.toBeInTheDocument();
    });
  });

  describe('No banner (happy path)', () => {
    it('shows no banner when connected and synced', async () => {
      await renderEditorView({
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
      const { rerender } = await renderEditorView({
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
          aiPanel={{ isOpen: false, toggle: vi.fn(), focusPopup: vi.fn(), isPoppedOut: false, position: 'right' }}
        />
      );

      // Banner should clear immediately when state becomes "no banner"
      expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
    });

    it('transitions from disconnected to connected after retry', async () => {
      const { rerender } = await renderEditorView({
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
          aiPanel={{ isOpen: false, toggle: vi.fn(), focusPopup: vi.fn(), isPoppedOut: false, position: 'right' }}
        />
      );

      // Banner should clear immediately when state becomes "no banner"
      expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    });

    it('transitions from syncing to synced correctly', async () => {
      const { rerender } = await renderEditorView({
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
          aiPanel={{ isOpen: false, toggle: vi.fn(), focusPopup: vi.fn(), isPoppedOut: false, position: 'right' }}
        />
      );

      // Banner should clear immediately when state becomes "no banner"
      expect(screen.queryByText('Syncing...')).not.toBeInTheDocument();
    });

    it('transitions from authError to connected after retry', async () => {
      const { rerender } = await renderEditorView({
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
          aiPanel={{ isOpen: false, toggle: vi.fn(), focusPopup: vi.fn(), isPoppedOut: false, position: 'right' }}
        />
      );

      // Banner should clear immediately when state becomes "no banner"
      expect(screen.queryByText(/Connection failed/)).not.toBeInTheDocument();
    });
  });

  describe('Auth redirect', () => {
    let originalLocation;

    beforeEach(() => {
      originalLocation = window.location;
      delete window.location;
      window.location = { href: '', pathname: '/docs/test' };
      // Fake timers are already enabled in parent beforeEach
    });

    afterEach(() => {
      window.location = originalLocation;
    });

    it('redirects to /login when authError and not authenticated', async () => {
      await renderEditorView(
        { authError: true, connectionState: 'disconnected' },
        { isAuthenticated: false, accessToken: null, user: null }
      );

      // Advance past the 2 second delay (banner debounce already done by renderEditorView)
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      expect(window.location.href).toContain('/login');
    });

    it('does NOT redirect immediately (has delay)', async () => {
      await renderEditorView(
        { authError: true, connectionState: 'disconnected' },
        { isAuthenticated: false, accessToken: null, user: null }
      );

      // Before the 2s redirect delay (banner debounce already done by renderEditorView)
      expect(window.location.href).not.toContain('/login');
    });

    it('does NOT redirect if still authenticated', async () => {
      await renderEditorView(
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
    it('authError takes priority over disconnected', async () => {
      await renderEditorView({
        authError: true,
        connectionState: 'disconnected',
        connected: false
      });

      expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
      expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    });

    it('authError takes priority over connecting', async () => {
      await renderEditorView({
        authError: true,
        connectionState: 'connecting',
        connected: false
      });

      expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
      expect(screen.queryByText(/Connecting/)).not.toBeInTheDocument();
    });

    it('authError takes priority over syncing', async () => {
      await renderEditorView({
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
