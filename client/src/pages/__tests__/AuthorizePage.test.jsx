/**
 * Feature 030 US3 + Feature 031 US3 (T006/T013/T014/T015): the consent page's
 * UNAUTHENTICATED state is the SOLE first-run consent surface after the collapse.
 * Asserts: the Continue-with-Google action goes DIRECTLY to /auth/google (no
 * /login hop, C1/FR-001); transparency copy is primary (full grant matching the
 * requested scopes + revocation line, C2/FR-009); a subordinate value reminder
 * from the verified messaging (C3/FR-014); the structural fold ordering
 * (transparency before value before the primary action, C4). The authenticated
 * consent card path is unchanged.
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

  it('renders a Continue-with-Google action that goes DIRECTLY to /auth/google (C1/FR-001)', async () => {
    render(<AuthorizePage />);
    const link = await screen.findByRole('link', { name: /continue with google/i });
    expect(link).toBeInTheDocument();
    // FR-001: direct Google entry — NO intermediate /login hop.
    expect(link.getAttribute('href')).toMatch(/^\/auth\/google\?returnTo=/);
    expect(link.getAttribute('href')).not.toMatch(/^\/login/);
    // The returnTo still carries the full authorize path+query.
    expect(decodeURIComponent(link.getAttribute('href'))).toContain('/authorize?agent_client_id=agent-xyz');
  });

  it('states that the same click creates the account (no separate signup step)', async () => {
    render(<AuthorizePage />);
    expect(await screen.findByText(/that same click creates your account/i)).toBeInTheDocument();
    expect(screen.getByText(/no separate\s+signup step/i)).toBeInTheDocument();
  });

  it('states the full write grant matching the requested scopes (C2/FR-009)', async () => {
    render(<AuthorizePage />);
    // write scope requested → names read + create/edit/delete, never narrower.
    expect(
      await screen.findByText(/read your documents, and create, edit, and delete documents/i),
    ).toBeInTheDocument();
  });

  it('includes the revocation line (C2/FR-009)', async () => {
    render(<AuthorizePage />);
    expect(
      await screen.findByText(/revoke this access anytime in Settings\s*→?\s*AI Agent Access/i),
    ).toBeInTheDocument();
  });

  it('states a strictly narrower read-only grant when documents:write is not requested', async () => {
    setSearch('?agent_client_id=agent-xyz&scope=documents:read');
    render(<AuthorizePage />);
    // grant lead names only reading; must NOT overstate create/edit/delete.
    expect(await screen.findByText(/will be able to read your documents in your Squire Docs/i)).toBeInTheDocument();
    expect(screen.queryByText(/create, edit, and delete documents/i)).not.toBeInTheDocument();
  });

  it('carries a subordinate value reminder drawn from the verified messaging (C3/FR-014)', async () => {
    render(<AuthorizePage />);
    expect(
      await screen.findByText(/humans and coding agents write the same spec together/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/two-way sync to the markdown in your repo/i)).toBeInTheDocument();
    expect(screen.getByText(/attributed to human or agent, and revertible/i)).toBeInTheDocument();
  });

  it('orders transparency (primary) before the value reminder before the primary action (C4 fold)', async () => {
    const { container } = render(<AuthorizePage />);
    await screen.findByRole('link', { name: /continue with google/i });
    // Structural fold proxy (jsdom has no layout): DOM order must place the
    // grant/transparency block ahead of the value reminder, and the primary
    // "Continue with Google" action last — so value copy can never push the
    // action above transparency or displace it in source order.
    const grant = container.querySelector('.authorize-firstrun-grant');
    const value = container.querySelector('.authorize-firstrun-points');
    const action = container.querySelector('.authorize-signin-link');
    expect(grant && value && action).toBeTruthy();
    const order = (el) => Array.prototype.indexOf.call(el.ownerDocument.querySelectorAll('*'), el);
    expect(order(grant)).toBeLessThan(order(value));
    expect(order(value)).toBeLessThan(order(action));
    // Value reminder stays tight (2–3 lines) so it cannot crowd the action off-screen.
    const valueLines = value.querySelectorAll('li').length;
    expect(valueLines).toBeGreaterThanOrEqual(2);
    expect(valueLines).toBeLessThanOrEqual(3);
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
