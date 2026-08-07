/**
 * DocList — the space surface (feature 053, FR-040/FR-041/FR-045).
 *
 * A separate file from DocList.test.jsx, which tests only the UUID helper and
 * has no render harness. These are render tests with a mocked api client, the
 * AdminPage.test.jsx pattern.
 *
 * The claim that matters most: the scope selector and the ownership filter are
 * ORTHOGONAL. "Owned by me" applies WITHIN the selected space, so both
 * parameters go out together — a UI that treated them as alternatives would
 * quietly hide documents.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DocList from '../DocList';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();

vi.mock('../../contexts/AuthContext', () => {
  const api = {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args),
    put: (...args) => mockPut(...args),
    delete: vi.fn(),
  };
  return { useAuth: () => ({ api, logout: vi.fn(), user: { id: 'me' } }) };
});

vi.mock('../Logo', () => ({ default: () => <div data-testid="logo" /> }));
vi.mock('../UserProfileBadge', () => ({ default: () => <div data-testid="badge" /> }));
vi.mock('../ViewToggleButton', () => ({ default: () => <div data-testid="view-toggle" /> }));
vi.mock('../ShareDialog', () => ({ default: () => null }));

const SPACES = [
  { id: 'space-1', name: 'Platform', role: 'owner', memberCount: 4 },
  { id: 'space-2', name: 'Design', role: 'editor', memberCount: 2 },
];

const DOCS = [
  {
    docGuid: 'doc-personal',
    title: 'Personal note',
    role: 'owner',
    updatedAt: '2026-08-01T10:00:00.000Z',
    shareCount: 1,
    spaceId: null,
    spaceName: null,
  },
  {
    docGuid: 'doc-in-space',
    title: 'Migration plan',
    role: 'editor',
    updatedAt: '2026-08-02T10:00:00.000Z',
    shareCount: 1,
    spaceId: 'space-1',
    spaceName: 'Platform',
  },
];

/** Every URL the list has requested, in order. */
const docUrls = () => mockGet.mock.calls.map((c) => c[0]).filter((u) => u.startsWith('/api/docs'));

describe('DocList — spaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockImplementation((url) => {
      if (url === '/api/spaces') return Promise.resolve({ data: { spaces: SPACES } });
      if (url.startsWith('/api/docs')) return Promise.resolve({ data: { docs: DOCS } });
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    mockPost.mockResolvedValue({ data: {} });
  });

  const renderList = (props = {}) =>
    render(
      <DocList
        onNavigate={() => {}}
        onNavigateToSpace={props.onNavigateToSpace || (() => {})}
        user={{ id: 'me', name: 'Me' }}
        {...props}
      />
    );

  it('lists the user\'s spaces in the scope selector, after My Docs', async () => {
    renderList();
    const selector = await screen.findByLabelText('Space');
    const options = Array.from(selector.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['All documents', 'My Docs', 'Platform', 'Design', '+ New space…']);
  });

  it('treats "+ New space…" as an action: opens the create dialog, keeps the scope', async () => {
    renderList();
    await screen.findByLabelText('Space');
    await userEvent.selectOptions(screen.getByLabelText('Space'), '__create__');

    // Dialog is open, the scope did not change to the sentinel.
    expect(await screen.findByRole('heading', { name: 'New space' })).toBeInTheDocument();
    expect(screen.getByLabelText('Space').value).toBe('all');
    // No docs request was made for the sentinel value.
    expect(docUrls().some((u) => u.includes('__create__'))).toBe(false);
  });

  it('creating a space posts the name and navigates to the new space\'s settings', async () => {
    const onNavigateToSpace = vi.fn();
    mockPost.mockResolvedValue({
      data: { space: { id: 'space-new', name: 'Growth', role: 'owner', memberCount: 1 } },
    });
    renderList({ onNavigateToSpace });

    await screen.findByLabelText('Space');
    await userEvent.selectOptions(screen.getByLabelText('Space'), '__create__');
    await userEvent.type(await screen.findByLabelText('Name'), 'Growth');
    await userEvent.click(screen.getByRole('button', { name: 'Create space' }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/spaces', { name: 'Growth' }));
    await waitFor(() => expect(onNavigateToSpace).toHaveBeenCalledWith('space-new'));
  });

  it('surfaces the server\'s refusal verbatim when creation fails', async () => {
    mockPost.mockRejectedValue({ response: { data: { error: 'Space name is required' } } });
    renderList();

    await screen.findByLabelText('Space');
    await userEvent.selectOptions(screen.getByLabelText('Space'), '__create__');
    await userEvent.type(await screen.findByLabelText('Name'), '   x');
    await userEvent.click(screen.getByRole('button', { name: 'Create space' }));

    expect(await screen.findByText('Space name is required')).toBeInTheDocument();
    // Dialog stays open for a retry.
    expect(screen.getByRole('heading', { name: 'New space' })).toBeInTheDocument();
  });

  it('shows each row\'s space as a chip, and none for a personal document', async () => {
    renderList();
    expect(await screen.findByText('Migration plan')).toBeInTheDocument();
    const chip = screen.getByTitle('In Platform');
    expect(chip).toHaveTextContent('Platform');
    // Only one chip: the personal document has no space.
    expect(screen.getAllByText('Platform', { selector: '.doc-space-chip' })).toHaveLength(1);
  });

  it('sends the space scope on the docs request', async () => {
    renderList();
    await screen.findByLabelText('Space');
    await userEvent.selectOptions(screen.getByLabelText('Space'), 'space-1');
    await waitFor(() => expect(docUrls().some((u) => u.includes('space=space-1'))).toBe(true));
  });

  it('omits the space parameter entirely for the default scope', async () => {
    renderList();
    await waitFor(() => expect(docUrls().length).toBeGreaterThan(0));
    expect(docUrls()[0]).toBe('/api/docs');
  });

  it('sends BOTH parameters — the ownership filter applies within the scope', async () => {
    renderList();
    await screen.findByLabelText('Space');
    await userEvent.selectOptions(screen.getByLabelText('Space'), 'space-1');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '' }) || screen.getAllByRole('combobox')[1], 'owned');

    await waitFor(() => {
      const last = docUrls()[docUrls().length - 1];
      expect(last).toContain('filter=owned');
      expect(last).toContain('space=space-1');
    });
  });

  it('offers the space name in the header as the way into its settings', async () => {
    const onNavigateToSpace = vi.fn();
    renderList({ onNavigateToSpace });
    await screen.findByLabelText('Space');
    await userEvent.selectOptions(screen.getByLabelText('Space'), 'space-1');

    const link = await screen.findByTitle('Manage Platform');
    await userEvent.click(link);
    expect(onNavigateToSpace).toHaveBeenCalledWith('space-1');
  });

  it('shows a move-documents-here empty state inside a space (FR-045)', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/api/spaces') return Promise.resolve({ data: { spaces: SPACES } });
      return Promise.resolve({ data: { docs: [] } });
    });
    renderList();
    await screen.findByLabelText('Space');
    await userEvent.selectOptions(screen.getByLabelText('Space'), 'space-1');

    expect(await screen.findByText('Nothing in Platform yet.')).toBeInTheDocument();
    expect(screen.getByText(/Move documents here from My Docs/)).toBeInTheDocument();
  });

  it('creating from a space scope posts the space id (FR-044)', async () => {
    renderList();
    await screen.findByLabelText('Space');
    await userEvent.selectOptions(screen.getByLabelText('Space'), 'space-1');

    await userEvent.click(screen.getAllByText(/New document/)[0]);
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/docs', expect.objectContaining({ spaceId: 'space-1' }))
    );
  });

  it('creating from My Docs does NOT post a space id', async () => {
    renderList();
    await screen.findByLabelText('Space');
    await userEvent.selectOptions(screen.getByLabelText('Space'), 'personal');

    await userEvent.click(screen.getAllByText(/New document/)[0]);
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('spaceId');
  });

  it('offers "Move to space" to a direct owner and disables it otherwise', async () => {
    renderList();
    await screen.findByText('Personal note');

    // The owned document's menu.
    const menus = screen.getAllByLabelText('More options');
    await userEvent.click(menus[0]);
    const owned = await screen.findByText('Move to space');
    expect(owned.closest('button')).not.toBeDisabled();

    // The editor-only document's menu.
    await userEvent.click(menus[1]);
    await waitFor(() => {
      const entry = screen.getByText('Move to space');
      expect(entry.closest('button')).toBeDisabled();
    });
  });

  it('survives a spaces endpoint failure — the list still renders', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/api/spaces') return Promise.reject(new Error('boom'));
      return Promise.resolve({ data: { docs: DOCS } });
    });
    renderList();
    expect(await screen.findByText('Personal note')).toBeInTheDocument();
  });
});
