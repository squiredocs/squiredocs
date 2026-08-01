import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

/**
 * US2 (024) — actions run through in-app dialogs, never window.prompt/confirm, and
 * still invoke the same callbacks with the same arguments (024/C5, FR-004/005).
 */
describe('HierarchicalVersionList — US2 in-app dialogs (024)', () => {
  function renderList(version, handlers = {}) {
    return render(
      <HierarchicalVersionList
        hierarchicalVersions={[{ label: 'January 2024', versions: [version] }]}
        selection={null}
        onSelectVersion={() => {}}
        onSelectUpdate={() => {}}
        onCreateNamedVersion={handlers.onCreateNamedVersion || vi.fn().mockResolvedValue(true)}
        onRenameVersion={handlers.onRenameVersion || vi.fn().mockResolvedValue(true)}
        onDeleteVersion={handlers.onDeleteVersion || vi.fn().mockResolvedValue(true)}
        onRestoreVersion={handlers.onRestoreVersion || vi.fn().mockResolvedValue(false)}
        userRole="editor"
        isLoading={false}
      />
    );
  }

  const baseVersion = {
    id: '5', name: null, clockStart: 1, clockEnd: 5,
    timestamp: '2024-01-05T16:30:00Z', authors: [], isNamed: false, isCurrent: false,
  };

  it('never calls window.prompt or window.confirm for any action', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('X');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const named = { ...baseVersion, name: 'Old name', isNamed: true };
    renderList(named);

    // Rename
    fireEvent.click(screen.getByTitle('Options'));
    fireEvent.click(screen.getByText('Rename'));
    expect(screen.getByRole('textbox').value).toBe('Old name');
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    // Restore
    fireEvent.click(screen.getByTitle('Options'));
    fireEvent.click(screen.getByText('Restore this version'));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    // Remove name
    fireEvent.click(screen.getByTitle('Options'));
    fireEvent.click(screen.getByText('Remove name'));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(promptSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it('name → onCreateNamedVersion(trimmedName, clockEnd)', async () => {
    const onCreateNamedVersion = vi.fn().mockResolvedValue(true);
    renderList(baseVersion, { onCreateNamedVersion });
    fireEvent.click(screen.getByTitle('Options'));
    fireEvent.click(screen.getByText('Name this version'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Milestone  ' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onCreateNamedVersion).toHaveBeenCalledWith('Milestone', 5);
  });

  it('rename → onRenameVersion(id, trimmedName)', async () => {
    const onRenameVersion = vi.fn().mockResolvedValue(true);
    const named = { ...baseVersion, name: 'Old', isNamed: true };
    renderList(named, { onRenameVersion });
    fireEvent.click(screen.getByTitle('Options'));
    fireEvent.click(screen.getByText('Rename'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onRenameVersion).toHaveBeenCalledWith('5', 'New name');
  });

  it('restore → onRestoreVersion(id)', async () => {
    const onRestoreVersion = vi.fn().mockResolvedValue(false);
    renderList(baseVersion, { onRestoreVersion });
    fireEvent.click(screen.getByTitle('Options'));
    fireEvent.click(screen.getByText('Restore this version'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onRestoreVersion).toHaveBeenCalledWith('5');
  });

  it('remove name → onDeleteVersion(id)', async () => {
    const onDeleteVersion = vi.fn().mockResolvedValue(true);
    const named = { ...baseVersion, name: 'Old', isNamed: true };
    renderList(named, { onDeleteVersion });
    fireEvent.click(screen.getByTitle('Options'));
    fireEvent.click(screen.getByText('Remove name'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove name' }));
    expect(onDeleteVersion).toHaveBeenCalledWith('5');
  });

  // Review HIGH-1 (2026-07-19): the hook signals failure WITHOUT throwing
  // (createNamedVersion → null, renameVersion/deleteNamedVersion → false).
  // The dialog must stay open with an error, exactly like the restore path.
  it('keeps the name dialog open with an error when createNamedVersion resolves null', async () => {
    const onCreateNamedVersion = vi.fn().mockResolvedValue(null);
    renderList(baseVersion, { onCreateNamedVersion });
    fireEvent.click(screen.getByTitle('Options'));
    fireEvent.click(screen.getByText('Name this version'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Milestone' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save the version name.');
    expect(screen.getByRole('textbox')).toBeInTheDocument(); // dialog still open
  });

  it('keeps the rename dialog open with an error when renameVersion resolves false', async () => {
    const onRenameVersion = vi.fn().mockResolvedValue(false);
    const named = { ...baseVersion, name: 'Old', isNamed: true };
    renderList(named, { onRenameVersion });
    fireEvent.click(screen.getByTitle('Options'));
    fireEvent.click(screen.getByText('Rename'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save the version name.');
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('keeps the remove-name dialog open with an error when deleteNamedVersion resolves false', async () => {
    const onDeleteVersion = vi.fn().mockResolvedValue(false);
    const named = { ...baseVersion, name: 'Old', isNamed: true };
    renderList(named, { onDeleteVersion });
    fireEvent.click(screen.getByTitle('Options'));
    fireEvent.click(screen.getByText('Remove name'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove name' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to remove the version name.');
    // dialog still open — the confirm button is still rendered
    expect(screen.getByRole('button', { name: 'Remove name' })).toBeInTheDocument();
  });
});

/**
 * US4 (024) — a successful row-menu restore navigates in-app to the doc and never
 * triggers a full-page reload (FR-012, C7).
 */
describe('HierarchicalVersionList — US4 restore navigation (024)', () => {
  const version = {
    id: '5', name: null, clockStart: 1, clockEnd: 5,
    timestamp: '2024-01-05T16:30:00Z', authors: [], isNamed: false, isCurrent: false,
  };

  it('invokes onNavigateToDoc(docGuid) and does not reload on successful restore', async () => {
    const onRestoreVersion = vi.fn().mockResolvedValue(true);
    const onNavigateToDoc = vi.fn();

    render(
      <HierarchicalVersionList
        hierarchicalVersions={[{ label: 'January 2024', versions: [version] }]}
        selection={null}
        onSelectVersion={() => {}}
        onSelectUpdate={() => {}}
        onRestoreVersion={onRestoreVersion}
        docGuid="doc-guid-123"
        onNavigateToDoc={onNavigateToDoc}
        userRole="editor"
        isLoading={false}
      />
    );

    fireEvent.click(screen.getByTitle('Options'));
    fireEvent.click(screen.getByText('Restore this version'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    // Let the awaited restore promise resolve. Because onNavigateToDoc is provided,
    // the restore path navigates in-app and never reaches window.location.reload().
    await waitFor(() => expect(onNavigateToDoc).toHaveBeenCalledWith('doc-guid-123'));
    expect(onRestoreVersion).toHaveBeenCalledWith('5');
  });
});

/**
 * Feature 039 US8 (FR-018) — the history author badge fallback color.
 *
 * The fallback used to be `generateColorFromId(author.id)`, whose hue is salted
 * with the CURRENT DATE. That daily rotation is deliberate for LIVE PRESENCE
 * (collaborators get a fresh palette each day) but wrong for history: the same
 * archived version's badge silently changed color overnight, so the color
 * carried no stable meaning and two viewers in different timezones could see
 * different colors for the same author. History now uses the stable neutral
 * `#888888`, matching the server's own no-identity fallback in
 * server/version-history.js.
 */
describe('HierarchicalVersionList — author badge fallback color (039 FR-018)', () => {
  const dotColor = (container) =>
    container.querySelector('.hierarchy-author-dot').style.backgroundColor;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the stable neutral #888888 for a colorless author, on any date', () => {
    // rgb(136, 136, 136) === #888888 (jsdom normalizes to rgb()).
    const NEUTRAL = 'rgb(136, 136, 136)';
    const colorless = [{ id: 'user-abc', name: 'Ada Lovelace' }];

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-03-01T12:00:00Z'));
    const first = renderWithVersion({ authors: colorless });
    const firstColor = dotColor(first.container);
    expect(firstColor).toBe(NEUTRAL);
    first.unmount();

    // A different day must not change the color.
    vi.setSystemTime(new Date('2024-09-17T12:00:00Z'));
    const second = renderWithVersion({ authors: colorless });
    const secondColor = dotColor(second.container);
    expect(secondColor).toBe(NEUTRAL);

    expect(secondColor).toBe(firstColor);
  });

  it('still honors an author color when one is supplied', () => {
    const { container } = renderWithVersion({
      authors: [{ id: 'user-abc', name: 'Ada Lovelace', color: '#ff0000' }],
    });
    expect(dotColor(container)).toBe('rgb(255, 0, 0)');
  });
});
