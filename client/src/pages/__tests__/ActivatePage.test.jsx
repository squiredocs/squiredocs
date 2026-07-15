/**
 * ActivatePage tests (feature 008, T023).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ActivatePage from '../ActivatePage';

vi.mock('../../components/Logo', () => ({ default: () => <div data-testid="logo" /> }));

// A mutable auth stub each test configures.
const mockApi = { post: vi.fn() };
let mockAuth;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

function authed() {
  return { user: { email: 'me@example.com' }, isAuthenticated: true, loading: false, api: mockApi };
}

describe('ActivatePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth = authed();
  });

  it('renders a sign-in prompt with the correct returnTo when unauthenticated', () => {
    mockAuth = { user: null, isAuthenticated: false, loading: false, api: mockApi };
    render(<ActivatePage />);
    const link = screen.getByRole('link', { name: /sign in with google/i });
    expect(link.getAttribute('href')).toMatch(/^\/login\?returnTo=/);
  });

  it('accepts a lowercase, hyphenated code and submits it', async () => {
    mockApi.post.mockResolvedValueOnce({
      data: { authorizationId: 'a1', agentName: 'Claude', scopes: ['documents:read', 'documents:write'] },
    });
    render(<ActivatePage />);
    const input = screen.getByLabelText(/activation code/i);
    await userEvent.type(input, 'wdjb-mjht');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(mockApi.post).toHaveBeenCalledWith('/mcp/login/code', { code: 'WDJB-MJHT' });
    await screen.findByText(/Approve this agent/i);
  });

  it('shows skeptical framing, both scopes, and renders a hostile agentName as inert text', async () => {
    mockApi.post.mockResolvedValueOnce({
      data: {
        authorizationId: 'a1',
        agentName: '<img src=x onerror=alert(1)>',
        scopes: ['documents:read', 'documents:write'],
      },
    });
    const { container } = render(<ActivatePage />);
    await userEvent.type(screen.getByLabelText(/activation code/i), 'wdjbmjht');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await screen.findByText(/An agent calling itself/i);
    expect(screen.getByText(/self-declared and has NOT been verified/i)).toBeTruthy();
    expect(screen.getByText('Read your documents')).toBeTruthy();
    expect(screen.getByText('Edit your documents')).toBeTruthy();
    // The hostile name is a literal text node, not markup.
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  async function reachConsent() {
    mockApi.post.mockResolvedValueOnce({
      data: { authorizationId: 'a1', agentName: 'Claude', scopes: ['documents:read'] },
    });
    render(<ActivatePage />);
    await userEvent.type(screen.getByLabelText(/activation code/i), 'wdjbmjht');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText(/Approve this agent/i);
  }

  it('Approve posts the decision with approved:true', async () => {
    await reachConsent();
    mockApi.post.mockResolvedValueOnce({ data: { status: 'approved' } });
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(mockApi.post).toHaveBeenLastCalledWith('/mcp/login/decision', {
      authorizationId: 'a1',
      approved: true,
    });
    await screen.findByText(/Agent connected/i);
  });

  it('Deny posts the decision with approved:false', async () => {
    await reachConsent();
    mockApi.post.mockResolvedValueOnce({ data: { status: 'denied' } });
    await userEvent.click(screen.getByRole('button', { name: /deny/i }));
    expect(mockApi.post).toHaveBeenLastCalledWith('/mcp/login/decision', {
      authorizationId: 'a1',
      approved: false,
    });
    await screen.findByText(/Request denied/i);
  });

  it('maps a 429 on code entry to a rate-limit message', async () => {
    mockApi.post.mockRejectedValueOnce({ response: { status: 429 } });
    render(<ActivatePage />);
    await userEvent.type(screen.getByLabelText(/activation code/i), 'wdjbmjht');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/Too many attempts/i)).toBeTruthy();
  });

  it('maps a 400 on code entry to invalid-or-expired', async () => {
    mockApi.post.mockRejectedValueOnce({ response: { status: 400 } });
    render(<ActivatePage />);
    await userEvent.type(screen.getByLabelText(/activation code/i), 'wdjbmjht');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/invalid or has expired/i)).toBeTruthy();
  });

  it('maps a 410 on decision to the expired result', async () => {
    await reachConsent();
    mockApi.post.mockRejectedValueOnce({ response: { status: 410 } });
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(await screen.findByRole('heading', { name: 'Request expired' })).toBeTruthy();
  });

  it('maps a 409 on decision to the token-limit result', async () => {
    await reachConsent();
    mockApi.post.mockRejectedValueOnce({ response: { status: 409 } });
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(await screen.findByText(/Token limit reached/i)).toBeTruthy();
  });

  it('maps a 400 on decision to the generic invalid result', async () => {
    await reachConsent();
    mockApi.post.mockRejectedValueOnce({ response: { status: 400 } });
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(await screen.findByText(/Something went wrong/i)).toBeTruthy();
  });
});
