/**
 * Feature 030 US3 (T020, FR-024, SC-005): the consent page's UNAUTHENTICATED
 * state is a first-run surface. Asserts the four framing elements render, and
 * that the authenticated consent card path is unchanged (copy-only change).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Mutable auth state the mocked useAuth returns per test.
let mockAuth;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

import AuthorizePage from '../AuthorizePage';

function setSearch(search) {
  window.location.pathname = '/authorize';
  window.location.search = search;
}

describe('AuthorizePage — unauthenticated first-run framing (SC-005)', () => {
  beforeEach(() => {
    setSearch('?agent_client_id=agent-xyz&scope=documents:read%20documents:write');
    // Agent-info fetch (used to name the agent in the "what the agent asks" line).
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ json: () => Promise.resolve({ name: 'Claude Code', description: 'Coding agent' }) }),
    ));
    mockAuth = { user: null, isAuthenticated: false, loading: false, api: { post: vi.fn() } };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the Continue-with-Google action', async () => {
    render(<AuthorizePage />);
    const link = await screen.findByRole('link', { name: /continue with google/i });
    expect(link).toBeInTheDocument();
    // Mechanics untouched: the returnTo link still carries the authorize path+query.
    expect(link.getAttribute('href')).toMatch(/^\/login\?returnTo=/);
    expect(decodeURIComponent(link.getAttribute('href'))).toContain('/authorize?agent_client_id=agent-xyz');
  });

  it('states that the same click creates the account', async () => {
    render(<AuthorizePage />);
    expect(await screen.findByText(/that same click creates your account/i)).toBeInTheDocument();
    expect(screen.getByText(/no separate\s+signup step/i)).toBeInTheDocument();
  });

  it('carries the product line (durable, attributed spec layer for agentic development)', async () => {
    render(<AuthorizePage />);
    expect(
      await screen.findByText(/durable, attributed spec layer for agentic\s+development/i),
    ).toBeInTheDocument();
  });

  it('carries the attribution/revertibility line', async () => {
    render(<AuthorizePage />);
    expect(await screen.findByText(/every agent edit is attributed and revertible/i)).toBeInTheDocument();
  });

  it('names what the agent is asking to do', async () => {
    render(<AuthorizePage />);
    expect(await screen.findByText(/wants to create and sync documents/i)).toBeInTheDocument();
  });

  it('states a read-only ask when documents:write is not requested', async () => {
    setSearch('?agent_client_id=agent-xyz&scope=documents:read');
    render(<AuthorizePage />);
    expect(await screen.findByText(/wants to read documents/i)).toBeInTheDocument();
    // must NOT overstate write access the agent never asked for
    expect(screen.queryByText(/create and sync documents/i)).not.toBeInTheDocument();
  });

  it('does NOT show the old existing-account "Sign in required" framing', async () => {
    render(<AuthorizePage />);
    await screen.findByRole('link', { name: /continue with google/i });
    expect(screen.queryByText(/sign in required/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/please sign in to authorize this application/i)).not.toBeInTheDocument();
  });
});

describe('AuthorizePage — authenticated consent card is unchanged (FR-024)', () => {
  beforeEach(() => {
    setSearch('?agent_client_id=agent-xyz&scope=documents:read%20documents:write&redirect_uri=http://localhost:3000/callback');
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ json: () => Promise.resolve({ name: 'Claude Code', description: 'Coding agent' }) }),
    ));
    mockAuth = {
      user: { email: 'user@example.com' },
      isAuthenticated: true,
      loading: false,
      api: { post: vi.fn() },
    };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the consent card with Authorize/Deny, not the first-run framing', async () => {
    render(<AuthorizePage />);
    expect(await screen.findByRole('heading', { name: /authorize claude code/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^authorize$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
    // First-run framing must not appear for an authenticated user.
    expect(screen.queryByText(/that same click creates your account/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /continue with google/i })).not.toBeInTheDocument();
  });
});
