/**
 * Feature 059 (T056, FR-024): the share dialog says a pending invite cannot be
 * accepted on a local instance; team mode keeps today's text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ShareDialog from '../ShareDialog';
import { stubProviders, LOCAL_PROVIDERS, TEAM_PROVIDERS } from '../../test/providers';

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('../../contexts/AuthContext', () => {
  const api = {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args),
    put: vi.fn(),
    delete: vi.fn(),
  };
  return { useAuth: () => ({ api, user: { id: 'me', emailEnabled: true } }) };
});
vi.mock('../Avatar', () => ({ default: () => <div data-testid="avatar" /> }));

describe('ShareDialog invite note', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({
      data: {
        users: [{ id: 'me', email: 'me@example.com', name: 'Me', picture: null, role: 'owner' }],
        invites: [],
        currentUserRole: 'owner',
        spaceGrant: null,
      },
    });
    mockPost.mockResolvedValue({ data: { invite: { email: 'friend@example.com', role: 'viewer' } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function invite() {
    const user = userEvent.setup();
    render(<ShareDialog docId="doc-1" docTitle="Plan" isOpen onClose={() => {}} />);
    await screen.findByText('People with access');
    const input = screen.getByPlaceholderText(/email/i);
    await user.type(input, 'friend@example.com');
    await user.keyboard('{Enter}');
  }

  it('local mode: the invite is recorded and the note says it cannot be accepted yet', async () => {
    stubProviders(LOCAL_PROVIDERS);
    await invite();
    expect(
      await screen.findByText(
        'Invite recorded for friend@example.com. This instance is in local mode, so nobody else can sign in to accept it until it moves to team mode.'
      )
    ).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledWith('/api/docs/doc-1/share', expect.objectContaining({ email: 'friend@example.com' }));
  });

  it('team mode: unchanged text', async () => {
    stubProviders(TEAM_PROVIDERS);
    await invite();
    expect(await screen.findByText('Invitation sent to friend@example.com')).toBeInTheDocument();
  });
});
