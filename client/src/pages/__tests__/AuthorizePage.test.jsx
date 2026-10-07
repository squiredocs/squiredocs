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

  it('leads by signing in to Squire Docs with a Google Account to connect the agent', async () => {
    render(<AuthorizePage />);
    expect(
      await screen.findByText(/sign in to Squire Docs with your Google Account to connect/i),
    ).toBeInTheDocument();
  });

  it('makes clear the grant is to the Squire Docs account, not the Google account', async () => {
    render(<AuthorizePage />);
    expect(
      await screen.findByText(/access to your Squire Docs account — not your\s+Google account/i),
    ).toBeInTheDocument();
  });

  it('states the full write grant matching the requested scopes (C2/FR-009)', async () => {
    render(<AuthorizePage />);
    // write scope requested → names read + create/edit/delete over Squire Docs
    // documents, never narrower.
    expect(
      await screen.findByText(/read, create, edit, and delete the documents in your Squire Docs account/i),
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
    expect(await screen.findByText(/read the documents in your Squire Docs account/i)).toBeInTheDocument();
    expect(screen.queryByText(/create, edit, and delete/i)).not.toBeInTheDocument();
  });

  it('carries a subordinate value reminder drawn from the verified messaging (C3/FR-014)', async () => {
    render(<AuthorizePage />);
    expect(
      await screen.findByText(/humans and coding agents write the same spec together/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/two-way sync to the markdown in your repo/i)).toBeInTheDocument();
    expect(screen.getByText(/attributed to human or agent, and revertible/i)).toBeInTheDocument();
  });

  it('places the transparency grant immediately before the primary action, action last (C4 fold)', async () => {
    const { container } = render(<AuthorizePage />);
    await screen.findByRole('link', { name: /continue with google/i });
    // The value reminder is the hook near the top; the transparency grant sits
    // directly above the action so the user reads exactly what they are granting
    // right before acting, and the "Continue with Google" action is LAST (never
    // pushed above the grant). jsdom has no layout, so this is a DOM-order proxy.
    const value = container.querySelector('.authorize-firstrun-points');
    const grant = container.querySelector('.authorize-firstrun-grant');
    const action = container.querySelector('.authorize-signin-link');
    expect(value && grant && action).toBeTruthy();
    const order = (el) => Array.prototype.indexOf.call(el.ownerDocument.querySelectorAll('*'), el);
    // Grant is the last content block before the action (informed consent adjacency).
    expect(order(grant)).toBeLessThan(order(action));
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

describe('AuthorizePage — feature 059 provider-driven first-run surface (FR-018, RBD-059-9)', () => {
  const AGENT = { name: 'Claude Code', description: 'Coding agent' };
  const stub = (providers) =>
    vi.stubGlobal('fetch', vi.fn((url) => {
      if (String(url).endsWith('/auth/providers')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(providers) });
      }
      return Promise.resolve({ json: () => Promise.resolve(AGENT) });
    }));

  beforeEach(() => {
    setSearch('?agent_client_id=agent-xyz&scope=documents:read%20documents:write');
    mockAuth = { user: null, isAuthenticated: false, loading: false, api: { post: vi.fn() } };
  });
  afterEach(() => vi.unstubAllGlobals());

  it('local mode: no "Google" anywhere, the instruction, and the agent and grant as today', async () => {
    stub({ mode: 'local', hasOwner: true, signupOpen: false, providers: [] });
    const { container } = render(<AuthorizePage />);
    expect(await screen.findByText('docker compose exec app squire claim-link')).toBeInTheDocument();
    await screen.findByText(/Sign in to this Squire Docs instance to connect Claude Code\./);
    expect(container.textContent).not.toMatch(/Google/);
    expect(screen.getByText(/read, create, edit, and delete the documents in your Squire Docs account/)).toBeInTheDocument();
    expect(screen.getByText(/come back to Claude Code and try again/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it("team mode: the action's href uses the registry start path", async () => {
    stub({ mode: 'team', hasOwner: true, signupOpen: true, providers: [{ id: 'google', label: 'Google', startPath: '/auth/google-alt' }] });
    render(<AuthorizePage />);
    const link = await screen.findByRole('link', { name: /continue with google/i });
    expect(link.getAttribute('href')).toMatch(/^\/auth\/google-alt\?returnTo=/);
    expect(decodeURIComponent(link.getAttribute('href'))).toContain('/authorize?agent_client_id=agent-xyz');
  });
});
