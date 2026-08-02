/**
 * Feature 041 US3 (FR-007/FR-008, SC-005) — end-to-end through EditorView.
 *
 * The header's "Restore this version" button posts `selection.id`. Before the
 * selection was reconciled against every refresh, that id was a click-time
 * snapshot: naming a mid-range clock re-splits the containing auto version into
 * new ids and ranges, and the button kept pointing at a range that no longer
 * existed. This exercises the real hook (only the network is mocked) across a
 * live-refresh tick.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import * as Y from 'yjs';
import EditorView from '../EditorView';
import { useYjs } from '../../hooks/useYjs';
import { useAuth } from '../../contexts/AuthContext';
import { useMobile } from '../../hooks/useMobile';
import { createControllableMockProvider, createMockAuthContext } from '../../test/utils';

vi.mock('../../hooks/useYjs');
vi.mock('../../contexts/AuthContext');
vi.mock('../../hooks/useMobile');

// Heavy/irrelevant children — the version-history view under test is the panel,
// the header and the real useVersionHistory hook.
vi.mock('../Editor', () => ({ default: () => <div data-testid="mock-editor">Editor</div> }));
vi.mock('../Toolbar', () => ({ default: () => <div data-testid="mock-toolbar">Toolbar</div> }));
vi.mock('../MobileActionBar', () => ({ default: () => null }));
vi.mock('../UserProfileBadge', () => ({ default: () => null }));
vi.mock('../ShareDialog', () => ({ default: () => null }));
vi.mock('../VersionPreview', () => ({ default: () => <div data-testid="mock-preview" /> }));

const DOC = 'doc-041';

// One auto version covering clocks 57-60, plus a newer current version so the
// 57-60 selection is not the current one (the header restore button is hidden
// for the current version).
const BEFORE = [
  { id: '70', name: null, clockStart: 65, clockEnd: 70, timestamp: '2025-01-01T11:00:00Z', authors: [], isNamed: false, isCurrent: true, onBehalfOf: [], onBehalfOfMore: 0 },
  { id: '60', name: null, clockStart: 57, clockEnd: 60, timestamp: '2025-01-01T10:03:00Z', authors: [], isNamed: false, isCurrent: false, onBehalfOf: [], onBehalfOfMore: 0 },
];

// After someone names clock 60 "Draft" (clocks 58-60), the 57-60 auto version is
// split into that named version plus a 57-57 fragment. The id the user clicked
// ('60') NO LONGER EXISTS — restoring it would 404 or, worse, resolve to some
// other range.
const AFTER = [
  { id: '70', name: null, clockStart: 65, clockEnd: 70, timestamp: '2025-01-01T11:00:00Z', authors: [], isNamed: false, isCurrent: true, onBehalfOf: [], onBehalfOfMore: 0 },
  { id: 'named-uuid', name: 'Draft', clockStart: 58, clockEnd: 60, timestamp: '2025-01-01T10:03:00Z', authors: [], isNamed: true, isCurrent: false, onBehalfOf: [], onBehalfOfMore: 0 },
  { id: '57', name: null, clockStart: 57, clockEnd: 57, timestamp: '2025-01-01T10:01:00Z', authors: [], isNamed: false, isCurrent: false, onBehalfOf: [], onBehalfOfMore: 0 },
];

describe('EditorView version history header restore (041 FR-007)', () => {
  let api;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };

    api.get.mockImplementation((url) => {
      if (url.includes('/history/diff')) return Promise.resolve({ data: { document: { type: 'doc', content: [] }, meta: {} } });
      if (url.includes('/history/updates')) return Promise.resolve({ data: { updates: [] } });
      if (url.endsWith('/history')) return Promise.resolve({ data: { versions: BEFORE, totalEdits: 70 } });
      return Promise.resolve({ data: {} });
    });
    api.post.mockResolvedValue({ data: { success: true } });

    vi.mocked(useYjs).mockReturnValue({
      ydoc: new Y.Doc(),
      provider: createControllableMockProvider(),
      awareness: null,
      connected: true,
      connectionState: 'connected',
      synced: true,
      users: [],
      docGuid: DOC,
      docTitle: 'Test Document',
      setDocTitle: vi.fn(),
      forceReconnect: vi.fn(),
      reconnectCount: 0,
      authError: false,
    });
    vi.mocked(useAuth).mockReturnValue({ ...createMockAuthContext(), api });
    vi.mocked(useMobile).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const renderView = () => render(
    <EditorView
      docGuid={DOC}
      showVersionHistory={true}
      onNavigateHome={vi.fn()}
      onNavigateToVersions={vi.fn()}
      onNavigateToSettings={vi.fn()}
      onNavigateToDoc={vi.fn()}
      user={{ id: 'user-1', name: 'Test User', email: 'test@example.com' }}
      aiPanel={{ isOpen: false, toggle: vi.fn(), focusPopup: vi.fn(), isPoppedOut: false, position: 'right' }}
    />
  );

  it('restores a version id that exists in the POST-split list after a live refresh', async () => {
    const { container } = renderView();

    // Wait for the timeline AND for the panel's own default selection (the
    // current version) to settle, so the click below is the user's choice.
    await waitFor(() => expect(container.querySelectorAll('.hierarchy-version-header').length).toBeGreaterThan(1));
    await waitFor(() => expect(container.querySelector('.hierarchy-item.selected')).toBeTruthy());

    const olderRow = Array.from(container.querySelectorAll('.hierarchy-version-header'))
      .find(r => r.textContent.includes('57'));
    expect(olderRow).toBeTruthy();
    await act(async () => { fireEvent.click(olderRow); });

    // Header offers restore for a non-current selection.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore this version' })).toBeTruthy());

    // Someone names clock 59 elsewhere; the live-refresh poll picks up the split.
    api.get.mockImplementation((url) => {
      if (url.includes('/history/diff')) return Promise.resolve({ data: { document: { type: 'doc', content: [] }, meta: {} } });
      if (url.includes('/history/updates')) return Promise.resolve({ data: { updates: [] } });
      if (url.endsWith('/history')) return Promise.resolve({ data: { versions: AFTER, totalEdits: 70 } });
      return Promise.resolve({ data: {} });
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });

    // FR-008: the newly named version appears without reopening the panel, and
    // FR-007 re-resolves the selection onto it (so the header title reads it too).
    await waitFor(() => expect(screen.getAllByText('Draft').length).toBeGreaterThan(0));
    await waitFor(() => expect(container.querySelector('.version-history-title').textContent).toBe('Draft'));

    // Restore through the header.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore this version' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore' })); });

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, body] = api.post.mock.calls.find(c => String(c[0]).includes('/restore'));
    expect(url).toBe(`/api/docs/${DOC}/restore`);
    // The clicked id is gone from the post-split world...
    expect(AFTER.some(v => v.id === '60')).toBe(false);
    // ...and the button posts the version that now CONTAINS the selected
    // clockEnd, not the stale click-time id.
    expect(body.versionId).toBe('named-uuid');
  });
});
