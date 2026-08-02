import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VersionHistoryPanel from '../VersionHistoryPanel';

/**
 * CHARACTERIZATION tests for feature 042 (US3, FR-012).
 *
 * `VersionHistoryPanel` had no dedicated coverage of its chrome before 042 —
 * 041 added an error-state suite, but nothing pinned the panel's rendered
 * output, and FR-012 rewrites how the panel hands data to the list. These
 * tests exist to make the prop-drill collapse provably output-preserving, so
 * they assert what the panel renders TODAY, including its exact wrapper class
 * names (which are part of the behavior contract — `contracts/
 * behavior-preservation.md` C6 — because the stylesheet keys on them).
 *
 * They are not a statement about what the panel SHOULD do. Anything surprising
 * below is pinned deliberately.
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

const version = (over = {}) => ({
  id: 'v1',
  name: null,
  clockStart: 1,
  clockEnd: 5,
  timestamp: '2024-01-05T16:30:00Z',
  authors: [],
  isNamed: false,
  isCurrent: false,
  onBehalfOf: [],
  onBehalfOfMore: 0,
  ...over,
});

const oneMonth = (...versions) => [{ label: 'January 2024', versions }];

describe('VersionHistoryPanel — rendered chrome (042 characterization)', () => {
  it('renders nothing at all when closed', () => {
    const { container } = renderPanel({ isOpen: false });
    expect(container.firstChild).toBeNull();
  });

  it('renders the header, the close affordance and the panel root class', () => {
    const { container } = renderPanel();

    expect(container.querySelector('.version-history-panel')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Version history' })).toBeTruthy();

    const close = container.querySelector('.version-history-close');
    expect(close).toBeTruthy();
    // The close affordance is a real link to the document, so Cmd/Ctrl-click
    // and middle-click keep working; a plain click is intercepted.
    expect(close.getAttribute('href')).toBe('/d/doc-1');
    expect(close.getAttribute('aria-label')).toBe('Close');
  });

  it('intercepts a plain click on the close link and calls onClose', () => {
    const onClose = vi.fn();
    const { container } = renderPanel({ onClose });

    fireEvent.click(container.querySelector('.version-history-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the filter select with both options, defaulting to all versions', () => {
    const { container } = renderPanel();

    const select = container.querySelector('.version-history-filter select');
    expect(select).toBeTruthy();
    expect(select.value).toBe('all');
    expect([...select.options].map(o => o.value)).toEqual(['all', 'named']);
    expect([...select.options].map(o => o.textContent)).toEqual([
      'All versions',
      'Named versions only',
    ]);
  });

  it('switching the filter to named swaps the empty-state copy (filter is panel-local state)', () => {
    const { container } = renderPanel();

    expect(screen.getByText('No version history yet.')).toBeTruthy();
    expect(screen.getByText('Edit the document to start tracking versions.')).toBeTruthy();

    fireEvent.change(container.querySelector('.version-history-filter select'), {
      target: { value: 'named' },
    });

    expect(screen.getByText('No named versions yet.')).toBeTruthy();
    expect(screen.getByText('Name a version using the menu on any version.')).toBeTruthy();
  });

  it('renders the highlight toggle reflecting showDiffHighlights and reports changes', () => {
    const onToggleDiffHighlights = vi.fn();
    const { container } = renderPanel({ showDiffHighlights: false, onToggleDiffHighlights });

    const label = container.querySelector('.version-history-highlight-toggle');
    expect(label).toBeTruthy();
    expect(label.textContent).toContain('Highlight changes');

    const box = label.querySelector('input[type="checkbox"]');
    expect(box.checked).toBe(false);

    fireEvent.click(box);
    expect(onToggleDiffHighlights).toHaveBeenCalledWith(true);
  });

  it('does not blow up when onToggleDiffHighlights is absent', () => {
    const { container } = renderPanel({ onToggleDiffHighlights: undefined });
    expect(() => {
      fireEvent.click(container.querySelector('.version-history-highlight-toggle input'));
    }).not.toThrow();
  });

  it('renders the PANEL empty state inside .version-history-empty / -empty-hint', () => {
    const { container } = renderPanel();

    const empty = container.querySelector('.version-history-empty');
    expect(empty).toBeTruthy();
    expect(empty.querySelector('.version-history-empty-hint')).toBeTruthy();
    // The list's own empty state uses DIFFERENT wrapper classes and must not
    // render here (contract C6 — the two empty states are not interchangeable).
    expect(container.querySelector('.hierarchy-empty-state')).toBeNull();
  });

  it('renders the LIST empty state (hierarchy-* classes) when versions exist but none are named', () => {
    const { container } = renderPanel({ hierarchicalVersions: oneMonth(version()) });

    fireEvent.change(container.querySelector('.version-history-filter select'), {
      target: { value: 'named' },
    });

    const empty = container.querySelector('.hierarchy-empty-state');
    expect(empty).toBeTruthy();
    expect(empty.querySelector('.hierarchy-empty-hint')).toBeTruthy();
    expect(screen.getByText('No named versions yet.')).toBeTruthy();
    // …and NOT the panel's wrapper, because the panel only renders its own
    // empty state when the whole list is empty.
    expect(container.querySelector('.version-history-empty')).toBeNull();
  });

  it('mounts the list only when there is at least one version', () => {
    const { container: emptyPanel } = renderPanel();
    expect(emptyPanel.querySelector('.hierarchy-list')).toBeNull();

    const { container } = renderPanel({ hierarchicalVersions: oneMonth(version()) });
    expect(container.querySelector('.hierarchy-list')).toBeTruthy();
  });

  it('PINNED QUIRK: isLoading still reaches the list, which replaces the rows with its own loading text', () => {
    // Post-041 the panel keeps the list mounted whenever versions exist, but it
    // also still forwards `isLoading`, and the list short-circuits on it. So a
    // FOREGROUND refetch (rename/restore/delete) does tear the rows down after
    // all. 042 is behavior-preserving, so this is pinned, not fixed: the
    // list-level loading branch is reachable and must stay.
    const { container } = renderPanel({
      isLoading: true,
      hierarchicalVersions: oneMonth(version({ name: 'Draft', isNamed: true })),
    });

    expect(screen.getByText('Loading versions...')).toBeTruthy();
    expect(container.querySelector('.hierarchy-loading')).toBeTruthy();
    // The panel's own loading placeholder is NOT what rendered — that one only
    // stands in for a genuinely empty list.
    expect(container.querySelector('.version-history-loading')).toBeNull();
    expect(screen.queryByText('Draft')).toBeNull();
  });

  it('renders the footer edit count, pluralized, only when there are edits', () => {
    const { container: none } = renderPanel({ totalEdits: 0 });
    expect(none.querySelector('.version-history-footer')).toBeNull();

    const { container: one } = renderPanel({ totalEdits: 1 });
    expect(one.querySelector('.version-history-footer').textContent).toBe('Total: 1 edit');

    const { container: many } = renderPanel({ totalEdits: 12 });
    expect(many.querySelector('.version-history-footer').textContent).toBe('Total: 12 edits');
  });

  it('passes its data through to the list so rows render', () => {
    renderPanel({
      hierarchicalVersions: oneMonth(version({ name: 'Draft', isNamed: true })),
    });

    expect(screen.getByText('January 2024')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
  });

  it('wires the list row click through to onSelectVersion', () => {
    const onSelectVersion = vi.fn();
    const v = version({ name: 'Draft', isNamed: true });
    renderPanel({ hierarchicalVersions: oneMonth(v), onSelectVersion });

    fireEvent.click(screen.getByText('Draft'));
    expect(onSelectVersion).toHaveBeenCalledWith(v);
  });
});
