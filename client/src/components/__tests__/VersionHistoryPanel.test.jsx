import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import VersionHistoryPanel from '../VersionHistoryPanel';

/**
 * Feature 041 US2 (FR-005, SC-003): a failed history load must render an error
 * with a working retry — never the "No version history yet" empty state, which
 * claims the document has no history when the truth is that we could not read
 * it. That empty text is reserved for a SUCCESSFUL zero-version response.
 */
function renderPanel(props = {}) {
  return render(
    <VersionHistoryPanel
      docGuid="doc-1"
      isOpen={true}
      onClose={() => {}}
      onSelectVersion={() => {}}
      selection={null}
      hierarchicalVersions={[]}
      totalEdits={0}
      isLoading={false}
      {...props}
    />
  );
}

describe('VersionHistoryPanel error state (041 FR-005)', () => {
  it('renders the error state and never the empty state when the load failed', () => {
    renderPanel({ error: 'Failed to load version history' });

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Couldn't load version history/i)).toBeTruthy();
    expect(screen.getByText('Failed to load version history')).toBeTruthy();

    expect(screen.queryByText(/No version history yet/i)).toBeNull();
    expect(screen.queryByText(/Edit the document to start tracking versions/i)).toBeNull();
  });

  it('offers a Retry that calls back into the history fetch', () => {
    const onRetry = vi.fn();
    renderPanel({ error: 'boom', onRetry });

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders the empty state for a SUCCESSFUL zero-version response', () => {
    renderPanel({ error: null });

    expect(screen.getByText(/No version history yet/i)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not claim emptiness while the first load is still in flight', () => {
    renderPanel({ isLoading: true });

    expect(screen.getByText(/Loading versions/i)).toBeTruthy();
    expect(screen.queryByText(/No version history yet/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the last-good list visible alongside the error after a failed refresh', () => {
    const version = {
      id: 'v1',
      name: 'Draft',
      clockStart: 1,
      clockEnd: 5,
      timestamp: '2024-01-05T16:30:00Z',
      authors: [],
      isNamed: true,
      isCurrent: false,
      onBehalfOf: [],
      onBehalfOfMore: 0,
    };

    renderPanel({
      error: 'refresh boom',
      hierarchicalVersions: [{ label: 'January 2024', versions: [version] }],
    });

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.queryByText(/No version history yet/i)).toBeNull();
  });

  // Review L1: the two channels do not bleed. A drill-down that failed says so
  // on its own row; the panel-level "Couldn't load version history." is about
  // the timeline, and rendering it over a healthy list would be a lie.
  it('never renders the panel error when only a drill-down failed', () => {
    const version = {
      id: 'v1',
      name: 'Draft',
      clockStart: 1,
      clockEnd: 5,
      timestamp: '2024-01-05T16:30:00Z',
      authors: [],
      isNamed: true,
      isCurrent: false,
      onBehalfOf: [],
      onBehalfOfMore: 0,
    };

    renderPanel({
      error: null,
      hierarchicalVersions: [{ label: 'January 2024', versions: [version] }],
      versionUpdatesError: { v1: 'updates boom' },
    });

    expect(screen.queryByText(/Couldn't load version history/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.getByText('Draft')).toBeTruthy();
  });
});

/**
 * Feature 043 US7 (FR-009, SC-006) — selection → preview → restore wiring, and
 * the post-040/041 attribution labels.
 *
 * This block owns two of US7's four coverage areas; VersionPreview.test.jsx
 * owns diff-document rendering, and the 041 block above already owns
 * error-state rendering. Assertions are about WIRING, not styling: which
 * callback fires, with which version's identity.
 *
 * Rendering note (post-042): the panel is itself the VersionHistoryProvider —
 * it still declares every prop, and memoizes fifteen of them into the context
 * its list subtree consumes. So a plain `render(<VersionHistoryPanel ... />)`
 * with props is the correct harness; no provider wrapper is needed, and adding
 * one would test the wrong thing. The row menu is portaled to document.body,
 * so query it through `screen`, never the render container.
 */
function versionRow(over = {}) {
  return {
    id: 'v1',
    name: 'Draft',
    clockStart: 1,
    clockEnd: 5,
    timestamp: '2024-01-05T16:30:00Z',
    authors: [],
    isNamed: true,
    isCurrent: false,
    isSubVersion: false,
    onBehalfOf: [],
    onBehalfOfMore: 0,
    ...over,
  };
}

const oneMonth = (...versions) => [{ label: 'January 2024', versions }];

describe('VersionHistoryPanel selection and restore wiring (043 US7, FR-009)', () => {
  it('selecting a version reports THAT version, not an index or an id', () => {
    const onSelectVersion = vi.fn();
    const target = versionRow({ id: 'v2', name: 'Second draft', clockEnd: 9 });
    renderPanel({
      onSelectVersion,
      hierarchicalVersions: oneMonth(versionRow(), target),
    });

    fireEvent.click(screen.getByText('Second draft'));

    expect(onSelectVersion).toHaveBeenCalledTimes(1);
    // The whole version object, so the preview can render its clocks and
    // authors without a second lookup that could resolve to a different row.
    expect(onSelectVersion).toHaveBeenCalledWith(expect.objectContaining({ id: 'v2', clockEnd: 9 }));
  });

  it('confirming restore fires the restore action with the identity of the version whose menu was opened', async () => {
    const onRestoreVersion = vi.fn().mockResolvedValue(true);
    const onNavigateToDoc = vi.fn();
    renderPanel({
      onRestoreVersion,
      onNavigateToDoc,
      userRole: 'editor',
      hierarchicalVersions: oneMonth(
        versionRow({ id: 'v1', name: 'Draft' }),
        versionRow({ id: 'v2', name: 'Second draft' })
      ),
    });

    // Open the SECOND row's menu, so a wiring bug that always restores the
    // first (or the selected) version cannot pass.
    const menuButtons = screen.getAllByTitle('Options');
    fireEvent.click(menuButtons[1]);
    fireEvent.click(screen.getByText('Restore this version'));

    // The confirm dialog stands between the menu and the action.
    expect(screen.getByText('Restore this version?')).toBeTruthy();
    expect(onRestoreVersion).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    });

    expect(onRestoreVersion).toHaveBeenCalledTimes(1);
    expect(onRestoreVersion).toHaveBeenCalledWith('v2');
    // On success the flow navigates to the live document in-app (024 FR-012).
    expect(onNavigateToDoc).toHaveBeenCalledWith('doc-1');
  });

  it('cancelling the confirm restores nothing', () => {
    const onRestoreVersion = vi.fn();
    renderPanel({
      onRestoreVersion,
      userRole: 'editor',
      hierarchicalVersions: oneMonth(versionRow()),
    });

    fireEvent.click(screen.getByTitle('Options'));
    fireEvent.click(screen.getByText('Restore this version'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onRestoreVersion).not.toHaveBeenCalled();
    expect(screen.queryByText('Restore this version?')).toBeNull();
  });

  it('a failed restore keeps the dialog open and says so, instead of claiming success', async () => {
    const onRestoreVersion = vi.fn().mockResolvedValue(false);
    const onNavigateToDoc = vi.fn();
    renderPanel({
      onRestoreVersion,
      onNavigateToDoc,
      userRole: 'editor',
      hierarchicalVersions: oneMonth(versionRow()),
    });

    fireEvent.click(screen.getByTitle('Options'));
    fireEvent.click(screen.getByText('Restore this version'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    });

    expect(screen.getByText('Failed to restore this version.')).toBeTruthy();
    expect(screen.getByText('Restore this version?')).toBeTruthy();
    expect(onNavigateToDoc).not.toHaveBeenCalled();
  });

  it('a viewer is offered no restore at all', () => {
    // The client gate is not the security boundary (the server is), but a
    // viewer being shown an action that will be refused is its own defect.
    renderPanel({
      onRestoreVersion: vi.fn(),
      userRole: 'viewer',
      hierarchicalVersions: oneMonth(versionRow()),
    });

    fireEvent.click(screen.getByTitle('Options'));
    expect(screen.queryByText('Restore this version')).toBeNull();
  });
});

describe('VersionHistoryPanel attribution labels (043 US7, ledger D8)', () => {
  it('renders the author names the server resolved, for a human and for an agent', () => {
    renderPanel({
      hierarchicalVersions: oneMonth(
        versionRow({
          id: 'v1',
          name: 'Human work',
          authors: [{ id: 'u1', name: 'Ada Lovelace', color: '#112233', isAgent: false }],
        }),
        versionRow({
          id: 'v2',
          name: 'Agent work',
          // The server composes "<agent> (<human>)" so an agent edit never
          // reads as the human's own keystrokes, nor loses whose behalf it was on.
          authors: [{ id: 'a1', name: 'Claude (Ada Lovelace)', color: '#445566', isAgent: true }],
        })
      ),
    });

    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('Claude (Ada Lovelace)')).toBeTruthy();
  });

  it('labels relayed content as synced rather than crediting the relayer (045)', () => {
    renderPanel({
      hierarchicalVersions: oneMonth(
        versionRow({ authors: [{ id: 'sync', name: 'Synced content', isSynced: true }] })
      ),
    });

    const name = screen.getByText('Synced content');
    expect(name).toBeTruthy();
    // An honest non-person marker, not a coloured person dot.
    expect(name.parentElement.querySelector('.hierarchy-author-dot-synced')).toBeTruthy();
  });

  it('presents NO undo affordance for a web-UI restore', () => {
    // Design ground truth, 2026-08-02 amendment (design/collaboration-core.md,
    // 040 US1/US6 CUT, ledger D8): a human's web-UI restore is attributed to
    // the human in the update log and is simply NOT an undo target — you revert
    // one by restoring again. The pre-cut behavior put a human's restore into
    // the chat assistant's undo queue under the assistant's name. This is the
    // negative that fails if that behavior is ever revived in the UI.
    const { container } = renderPanel({
      userRole: 'editor',
      onRestoreVersion: vi.fn(),
      hierarchicalVersions: oneMonth(
        versionRow({
          id: 'v1',
          name: 'Restored to Draft',
          authors: [{ id: 'u1', name: 'Ada Lovelace', color: '#112233' }],
        })
      ),
    });

    fireEvent.click(screen.getByTitle('Options'));

    expect(screen.queryByText(/undo/i)).toBeNull();
    expect(container.textContent).not.toMatch(/undo/i);
    // ...and the restore path is still offered, so this is not passing by
    // virtue of an empty menu.
    expect(screen.getByText('Restore this version')).toBeTruthy();
  });
});
