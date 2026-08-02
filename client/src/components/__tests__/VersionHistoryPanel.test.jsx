import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
