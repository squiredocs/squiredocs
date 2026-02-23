/**
 * EditorView Tools Menu Tests
 *
 * Tests the 3-dot tools menu in EditorView:
 * - Print button renders and calls window.print()
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

// Mock child components not needed for these tests
vi.mock('../Editor', () => ({
  default: () => <div data-testid="mock-editor">Editor</div>
}));

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

const TEST_DOC_GUID = 'test-doc-guid-12345';
const BANNER_DEBOUNCE_MS = 500;

describe('EditorView tools menu', () => {
  let mockProvider;
  let mockYdoc;
  let defaultYjsReturn;
  let defaultAuthReturn;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockProvider = createControllableMockProvider();
    mockYdoc = new Y.Doc();

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

    // Return a role so the tools menu renders (gated on docInfoLoaded && userRole)
    defaultAuthReturn = createMockAuthContext({
      api: {
        get: vi.fn(() => Promise.resolve({ data: { role: 'owner' } })),
        post: vi.fn(() => Promise.resolve({ data: {} })),
        put: vi.fn(() => Promise.resolve({ data: {} })),
        delete: vi.fn(() => Promise.resolve({ data: {} })),
        interceptors: {
          request: { use: vi.fn(), eject: vi.fn() },
          response: { use: vi.fn(), eject: vi.fn() }
        }
      }
    });

    vi.mocked(useYjs).mockReturnValue(defaultYjsReturn);
    vi.mocked(useAuth).mockReturnValue(defaultAuthReturn);

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

    vi.mocked(useMobile).mockReturnValue(false);

    // Mock window.print
    window.print = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const renderEditorView = async () => {
    const result = render(
      <EditorView
        docGuid={TEST_DOC_GUID}
        onNavigateHome={vi.fn()}
        onNavigateToVersions={vi.fn()}
        onNavigateToSettings={vi.fn()}
        user={{ id: 'user-1', name: 'Test User', email: 'test@example.com' }}
      />
    );

    // Flush the async fetchDocInfo effect so docInfoLoaded/userRole are set
    await act(async () => {
      vi.advanceTimersByTime(BANNER_DEBOUNCE_MS);
    });

    return result;
  };

  const openToolsMenu = () => {
    const menuBtn = screen.getByRole('button', { name: 'More options' });
    fireEvent.click(menuBtn);
  };

  it('shows Print item in the tools menu', async () => {
    await renderEditorView();
    openToolsMenu();

    expect(screen.getByText('Print')).toBeInTheDocument();
  });

  it('calls window.print() when Print is clicked', async () => {
    await renderEditorView();
    openToolsMenu();

    const printBtn = screen.getByText('Print').closest('button');
    fireEvent.click(printBtn);

    expect(window.print).toHaveBeenCalledOnce();
  });

  it('closes the menu after clicking Print', async () => {
    await renderEditorView();
    openToolsMenu();

    expect(screen.getByText('Print')).toBeInTheDocument();

    const printBtn = screen.getByText('Print').closest('button');
    fireEvent.click(printBtn);

    // Menu dropdown should be gone
    expect(screen.queryByText('Print')).not.toBeInTheDocument();
  });
});
