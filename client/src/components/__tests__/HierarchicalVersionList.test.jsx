import { describe, it, expect } from 'vitest';
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
