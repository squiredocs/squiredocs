import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HierarchicalVersionList from '../HierarchicalVersionList';

/**
 * Render the list with a single month containing one version. The first month
 * auto-expands, so the version (and its OnBehalfOfList) renders immediately.
 */
function renderWithVersion(overrides) {
  const version = {
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
    ...overrides,
  };
  return render(
    <HierarchicalVersionList
      hierarchicalVersions={[{ label: 'January 2024', versions: [version] }]}
      selection={null}
      onSelectVersion={() => {}}
      onSelectUpdate={() => {}}
      userRole="editor"
      isLoading={false}
    />
  );
}

describe('HierarchicalVersionList — OnBehalfOfList (sync provenance)', () => {
  it('renders a deduped identity with push count and latest commit', () => {
    const { container } = renderWithVersion({
      onBehalfOf: [{ name: 'CI Bot', email: 'ci@x.com', commitCount: 3, latestCommit: 'ccc333' }],
    });
    const line = container.querySelector('.hierarchy-onbehalfof-line');
    expect(line.textContent).toBe('on behalf of CI Bot · ci@x.com (3 pushes, latest ccc333)');
  });

  it('uses singular "push" for a single push', () => {
    const { container } = renderWithVersion({
      onBehalfOf: [{ name: 'Dev', commitCount: 1, latestCommit: 'ddd444' }],
    });
    const line = container.querySelector('.hierarchy-onbehalfof-line');
    expect(line.textContent).toBe('on behalf of Dev (1 push, latest ddd444)');
  });

  it('falls back to "unknown" when an identity has neither name nor email', () => {
    const { container } = renderWithVersion({
      onBehalfOf: [{ commitCount: 2, latestCommit: 'bbb' }],
    });
    const line = container.querySelector('.hierarchy-onbehalfof-line');
    expect(line.textContent).toBe('on behalf of unknown (2 pushes, latest bbb)');
  });

  it('renders a "+K more" overflow line when the identity list is capped', () => {
    const onBehalfOf = Array.from({ length: 10 }, (_, i) => ({
      name: `Pusher ${i}`,
      commitCount: 1,
    }));
    const { container } = renderWithVersion({ onBehalfOf, onBehalfOfMore: 5 });
    const lines = container.querySelectorAll('.hierarchy-onbehalfof-line');
    expect(lines).toHaveLength(11); // 10 identities + 1 overflow line
    const more = container.querySelector('.hierarchy-onbehalfof-more');
    expect(more.textContent).toBe('+5 more');
  });

  it('renders nothing when there is no provenance', () => {
    const { container } = renderWithVersion({ onBehalfOf: [], onBehalfOfMore: 0 });
    expect(container.querySelector('.hierarchy-onbehalfof')).toBeNull();
  });

  it('renders hostile identity/commit strings as inert text (no markup injected)', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = renderWithVersion({
      onBehalfOf: [{ name: hostile, latestCommit: hostile, commitCount: 1 }],
    });
    // The hostile string must not become a real element.
    expect(container.querySelector('img')).toBeNull();
    const line = container.querySelector('.hierarchy-onbehalfof-line');
    expect(line.textContent).toContain(hostile);
    // It is present strictly as text, not as child HTML.
    expect(line.innerHTML).not.toContain('<img');
  });
});

describe('HierarchicalVersionList — selection highlight (F4)', () => {
  it('highlights only the sub-version, not its id-colliding parent, on sub-version select', () => {
    // A sub-version's id equals its parent version's id (both String(clockEnd)).
    const version = {
      id: '5', name: null, clockStart: 1, clockEnd: 5,
      timestamp: '2024-01-05T16:30:00Z', authors: [], isNamed: false, isCurrent: false,
    };
    const subVersion = {
      id: '5', clockStart: 5, clockEnd: 5,
      timestamp: '2024-01-05T16:30:00Z', authors: [], updateCount: 1,
    };

    const { container } = render(
      <HierarchicalVersionList
        hierarchicalVersions={[{ label: 'January 2024', versions: [version] }]}
        selection={{ id: '5', isSubVersion: true }}
        onSelectVersion={() => {}}
        onSelectUpdate={() => {}}
        versionUpdates={{ '5': [subVersion] }}
        userRole="editor"
        isLoading={false}
      />
    );

    // Expand the parent version to render its sub-versions.
    fireEvent.click(screen.getByLabelText('Expand'));

    const selected = container.querySelectorAll('.hierarchy-item.selected');
    // Exactly one item is highlighted, and it is the sub-version (not the parent).
    expect(selected).toHaveLength(1);
    expect(selected[0].classList.contains('hierarchy-update')).toBe(true);
    expect(selected[0].classList.contains('hierarchy-version')).toBe(false);
  });

  it('shows a "Showing N of M edits" indicator when the version has more edits (F5)', () => {
    const version = {
      id: '5', name: null, clockStart: 1, clockEnd: 5,
      timestamp: '2024-01-05T16:30:00Z', authors: [], isNamed: false, isCurrent: false,
    };
    const updates = [
      { id: '5', clockStart: 5, clockEnd: 5, timestamp: '2024-01-05T16:30:00Z', authors: [], updateCount: 1 },
      { id: '4', clockStart: 4, clockEnd: 4, timestamp: '2024-01-05T16:29:00Z', authors: [], updateCount: 1 },
    ];

    render(
      <HierarchicalVersionList
        hierarchicalVersions={[{ label: 'January 2024', versions: [version] }]}
        selection={null}
        onSelectVersion={() => {}}
        onSelectUpdate={() => {}}
        versionUpdates={{ '5': updates }}
        versionUpdatesMeta={{ '5': { total: 12, hasMore: true } }}
        userRole="editor"
        isLoading={false}
      />
    );

    fireEvent.click(screen.getByLabelText('Expand'));
    expect(screen.getByText('Showing 2 of 12 edits')).toBeInTheDocument();
  });

  it('shows no indicator when the version has no further edits (F5)', () => {
    const version = {
      id: '5', name: null, clockStart: 1, clockEnd: 5,
      timestamp: '2024-01-05T16:30:00Z', authors: [], isNamed: false, isCurrent: false,
    };
    const updates = [
      { id: '5', clockStart: 5, clockEnd: 5, timestamp: '2024-01-05T16:30:00Z', authors: [], updateCount: 1 },
    ];

    const { container } = render(
      <HierarchicalVersionList
        hierarchicalVersions={[{ label: 'January 2024', versions: [version] }]}
        selection={null}
        onSelectVersion={() => {}}
        onSelectUpdate={() => {}}
        versionUpdates={{ '5': updates }}
        versionUpdatesMeta={{ '5': { total: 1, hasMore: false } }}
        userRole="editor"
        isLoading={false}
      />
    );

    fireEvent.click(screen.getByLabelText('Expand'));
    expect(container.querySelector('.hierarchy-updates-more')).toBeNull();
  });

  it('offers "Name this version" to a viewer (F9 permissive alignment)', () => {
    const version = {
      id: '5', name: null, clockStart: 1, clockEnd: 5,
      timestamp: '2024-01-05T16:30:00Z', authors: [], isNamed: false, isCurrent: false,
    };

    render(
      <HierarchicalVersionList
        hierarchicalVersions={[{ label: 'January 2024', versions: [version] }]}
        selection={null}
        onSelectVersion={() => {}}
        onSelectUpdate={() => {}}
        userRole="viewer"
        isLoading={false}
      />
    );

    // Open the item options menu.
    fireEvent.click(screen.getByTitle('Options'));
    expect(screen.getByText('Name this version')).toBeInTheDocument();
    // Restore stays edit-only (mutates the doc), so it is NOT offered to viewers.
    expect(screen.queryByText('Restore this version')).toBeNull();
  });

  it('highlights the parent version (only) when a top-level version is selected', () => {
    const version = {
      id: '5', name: null, clockStart: 1, clockEnd: 5,
      timestamp: '2024-01-05T16:30:00Z', authors: [], isNamed: false, isCurrent: false,
    };

    const { container } = render(
      <HierarchicalVersionList
        hierarchicalVersions={[{ label: 'January 2024', versions: [version] }]}
        selection={{ id: '5' }} // top-level version selection (no isSubVersion)
        onSelectVersion={() => {}}
        onSelectUpdate={() => {}}
        userRole="editor"
        isLoading={false}
      />
    );

    const selected = container.querySelectorAll('.hierarchy-item.selected');
    expect(selected).toHaveLength(1);
    expect(selected[0].classList.contains('hierarchy-version')).toBe(true);
  });
});

/**
 * US1 (024) — the row options menu must be reachable on every row (top-level AND
 * drill-down), open without selecting the row, render (portaled) fully, and close on
 * an outside pointer tap (touch-safe, not just mouse).
 */
describe('HierarchicalVersionList — US1 menu reachability & dismissal (024)', () => {
  const version = {
    id: '5', name: null, clockStart: 1, clockEnd: 5,
    timestamp: '2024-01-05T16:30:00Z', authors: [], isNamed: false, isCurrent: false,
  };
  const subVersion = {
    id: '5', clockStart: 5, clockEnd: 5,
    timestamp: '2024-01-05T16:30:00Z', authors: [], updateCount: 1,
  };

  function renderExpanded(extra = {}) {
    const utils = render(
      <HierarchicalVersionList
        hierarchicalVersions={[{ label: 'January 2024', versions: [version] }]}
        selection={null}
        onSelectVersion={extra.onSelectVersion || (() => {})}
        onSelectUpdate={extra.onSelectUpdate || (() => {})}
        versionUpdates={{ '5': [subVersion] }}
        userRole="editor"
        isLoading={false}
      />
    );
    // Expand the parent version so the drill-down (sub-version) row renders.
    fireEvent.click(screen.getByLabelText('Expand'));
    return utils;
  }

  it('renders an options menu button on a drill-down (sub-version) row', () => {
    renderExpanded();
    // Parent row + sub-version row each expose an Options button.
    expect(screen.getAllByTitle('Options').length).toBe(2);
  });

  it('opens the dropdown when a sub-version row menu is clicked', () => {
    renderExpanded();
    const menuButtons = screen.getAllByTitle('Options');
    // Second button belongs to the drill-down row.
    fireEvent.click(menuButtons[1]);
    // Sub-versions expose name + restore (no remove-name).
    expect(screen.getByText('Name this version')).toBeInTheDocument();
    expect(screen.getByText('Restore this version')).toBeInTheDocument();
  });

  it('opening the menu does not select the row', () => {
    const onSelectVersion = vi.fn();
    const onSelectUpdate = vi.fn();
    renderExpanded({ onSelectVersion, onSelectUpdate });
    const menuButtons = screen.getAllByTitle('Options');
    fireEvent.click(menuButtons[0]);
    fireEvent.click(menuButtons[1]);
    expect(onSelectVersion).not.toHaveBeenCalled();
    expect(onSelectUpdate).not.toHaveBeenCalled();
  });

  it('closes the open menu on an outside pointerdown (touch-safe dismissal)', () => {
    renderExpanded();
    fireEvent.click(screen.getAllByTitle('Options')[0]);
    expect(screen.getByText('Restore this version')).toBeInTheDocument();
    // A pointerdown outside the menu (touch tap) must close it.
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText('Restore this version')).toBeNull();
  });
});
