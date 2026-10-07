/**
 * SpaceSettingsPage — feature 053 (FR-042 / FR-024 / FR-010).
 *
 * The operations matrix made visible: an owner sees the management controls, a
 * viewer member does not, the last owner's leave is refused with the SERVER'S
 * guidance, and the delete confirmation states the document count and says
 * plainly that nothing is deleted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SpaceSettingsPage from '../SpaceSettingsPage';
import { stubProviders, LOCAL_PROVIDERS, TEAM_PROVIDERS } from '../../test/providers';

const mockGet = vi.fn();
const mockPatch = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();

vi.mock('../../contexts/AuthContext', () => {
  const api = {
    get: (...args) => mockGet(...args),
    patch: (...args) => mockPatch(...args),
    post: (...args) => mockPost(...args),
    put: (...args) => mockPut(...args),
    delete: (...args) => mockDelete(...args),
  };
  return { useAuth: () => ({ api, logout: vi.fn() }) };
});

vi.mock('../../components/Logo', () => ({ default: () => <div data-testid="logo" /> }));
vi.mock('../../components/UserProfileBadge', () => ({ default: () => <div data-testid="badge" /> }));
vi.mock('../../components/ViewToggleButton', () => ({ default: () => <div data-testid="toggle" /> }));
vi.mock('../../components/Avatar', () => ({ default: () => <div data-testid="avatar" /> }));

const ME = { id: 'user-me', name: 'Me', email: 'me@example.com' };

const detail = (role, extra = {}) => ({
  space: { id: 'space-1', name: 'Platform', role, documentCount: 12 },
  members: [
    { userId: 'user-me', email: 'me@example.com', name: 'Me', picture: null, role, grantedBy: 'user-me', createdAt: '' },
    { userId: 'user-other', email: 'other@example.com', name: 'Other', picture: null, role: 'editor', grantedBy: 'user-me', createdAt: '' },
  ],
  invites: [{ email: 'pending@example.com', role: 'viewer', createdAt: '' }],
  ...extra,
});

const LAST_OWNER =
  'A space must have at least one owner. Make another member an owner first, or delete the space.';

describe('SpaceSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockImplementation((url) => {
      if (url === '/api/spaces/space-1') return Promise.resolve({ data: detail('owner') });
      return Promise.resolve({ data: { users: [] } });
    });
  });

  const renderPage = (props = {}) =>
    render(
      <SpaceSettingsPage
        spaceId="space-1"
        onNavigateHome={props.onNavigateHome || (() => {})}
        user={ME}
        {...props}
      />
    );

  it('shows the management controls to an owner', async () => {
    renderPage();
    expect(await screen.findByLabelText('Space name')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByText('Delete space')).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
    expect(screen.getByText('Revoke')).toBeInTheDocument();
  });

  it('hides them from a viewer member, who can still leave and invite', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/api/spaces/space-1') return Promise.resolve({ data: detail('viewer') });
      return Promise.resolve({ data: { users: [] } });
    });
    renderPage();
    expect(await screen.findByText('Leave this space')).toBeInTheDocument();
    expect(screen.queryByLabelText('Space name')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete space')).not.toBeInTheDocument();
    expect(screen.queryByText('Remove')).not.toBeInTheDocument();
    expect(screen.queryByText('Revoke')).not.toBeInTheDocument();
  });

  it('caps the invite role picker at the caller\'s own role (FR-008)', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/api/spaces/space-1') return Promise.resolve({ data: detail('editor') });
      return Promise.resolve({ data: { users: [] } });
    });
    renderPage();
    const picker = await screen.findByLabelText('Invite role');
    const options = Array.from(picker.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['viewer', 'editor']);
  });

  it('an owner may grant owner', async () => {
    renderPage();
    const picker = await screen.findByLabelText('Invite role');
    const options = Array.from(picker.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['viewer', 'editor', 'owner']);
  });

  it('renames through PATCH', async () => {
    mockPatch.mockResolvedValue({ data: {} });
    renderPage();
    const input = await screen.findByLabelText('Space name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Infra');
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/api/spaces/space-1', { name: 'Infra' }));
  });

  it('invites through POST with the chosen role', async () => {
    mockPost.mockResolvedValue({ data: {} });
    renderPage();
    const email = await screen.findByLabelText('Invite by email');
    await userEvent.type(email, 'new@example.com');
    await userEvent.selectOptions(screen.getByLabelText('Invite role'), 'editor');
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/spaces/space-1/members', {
        email: 'new@example.com',
        role: 'editor',
      })
    );
  });

  it("surfaces the last-owner guidance verbatim when leaving is refused", async () => {
    mockDelete.mockRejectedValue({ response: { status: 409, data: { error: LAST_OWNER } } });
    const onNavigateHome = vi.fn();
    renderPage({ onNavigateHome });

    await userEvent.click(await screen.findByText('Leave this space'));

    expect(await screen.findByRole('alert')).toHaveTextContent(LAST_OWNER);
    // Still here — a refused leave must not navigate away.
    expect(onNavigateHome).not.toHaveBeenCalled();
  });

  it('states the document count before deleting, and that no document is deleted', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await userEvent.click(await screen.findByText('Delete space'));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0][0];
    expect(message).toContain('12 documents');
    expect(message).toContain('No document is deleted');
    // Declining the confirmation makes no request.
    expect(mockDelete).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('deletes and returns home once confirmed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockDelete.mockResolvedValue({ data: { deleted: true, documentsReverted: 12 } });
    const onNavigateHome = vi.fn();
    renderPage({ onNavigateHome });

    await userEvent.click(await screen.findByText('Delete space'));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/api/spaces/space-1'));
    await waitFor(() => expect(onNavigateHome).toHaveBeenCalled());
    confirmSpy.mockRestore();
  });

  it('a non-member sees only the not-found message (RBD-053-10)', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/api/spaces/space-1') {
        return Promise.reject({ response: { status: 404, data: { error: 'Space not found' } } });
      }
      return Promise.resolve({ data: { users: [] } });
    });
    renderPage();
    expect(await screen.findByText('Space not found')).toBeInTheDocument();
    expect(screen.queryByLabelText('Invite by email')).not.toBeInTheDocument();
  });

  describe('feature 059: local-mode invite note (FR-024)', () => {
    afterEach(() => vi.unstubAllGlobals());

    const invite = async () => {
      mockPost.mockResolvedValue({ data: { invite: { email: 'new@example.com', role: 'viewer' } } });
      renderPage();
      await userEvent.type(await screen.findByLabelText('Invite by email'), 'new@example.com');
      await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
    };

    it('local mode: a pending invite says it cannot be accepted until team mode', async () => {
      stubProviders(LOCAL_PROVIDERS);
      await invite();
      expect(
        await screen.findByText(
          'Invite recorded for new@example.com. This instance is in local mode, so nobody else can sign in to accept it until it moves to team mode.'
        )
      ).toBeInTheDocument();
    });

    it('team mode: the unchanged notice', async () => {
      stubProviders(TEAM_PROVIDERS);
      await invite();
      expect(await screen.findByText('Invited new@example.com.')).toBeInTheDocument();
    });
  });
});
