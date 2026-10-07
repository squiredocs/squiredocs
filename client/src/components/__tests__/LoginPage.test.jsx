/**
 * Feature 059 (T052, FR-017, US4-2, US4-5): the sign-in page renders from
 * GET /auth/providers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginPage from '../LoginPage';
import { stubProviders, LOCAL_PROVIDERS } from '../../test/providers';

let mockAuth;
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => mockAuth }));
vi.mock('../Logo', () => ({ default: () => <div data-testid="logo" /> }));

describe('LoginPage (provider-driven)', () => {
  beforeEach(() => {
    mockAuth = { login: vi.fn(), error: null, loading: false };
    window.location.search = '';
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['login', 'signup'])('local mode on /%s: the claim-link instruction, no button, no sign-up copy', async (mode) => {
    stubProviders(LOCAL_PROVIDERS);
    const { container } = render(<LoginPage mode={mode} />);
    expect(await screen.findByText('docker compose exec app squire claim-link')).toBeInTheDocument();
    expect(screen.getByText(/signs in with a one-time link/)).toBeInTheDocument();
    expect(screen.getByText('Welcome Back')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    const text = container.textContent;
    expect(text).not.toMatch(/Sign up|Sign Up|Don't have an account\?|Google/);
  });

  it('headline renders immediately; the action waits for the providers', async () => {
    let release;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { release = r; })));
    render(<LoginPage mode="login" />);
    expect(screen.getByText('Welcome Back')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    await waitFor(() => expect(typeof release).toBe('function'));
    release({ ok: true, json: () => Promise.resolve(LOCAL_PROVIDERS) });
    expect(await screen.findByText('docker compose exec app squire claim-link')).toBeInTheDocument();
  });

  it('a failed providers request renders the Google version (the hosted page)', async () => {
    stubProviders('fail');
    render(<LoginPage mode="login" />);
    expect(await screen.findByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
    expect(screen.getByText("Don't have an account?")).toBeInTheDocument();
  });

  it('the button starts sign-in at the registry start path (US4-5)', async () => {
    stubProviders({ mode: 'team', hasOwner: true, signupOpen: true, providers: [{ id: 'google', label: 'Google', startPath: '/auth/google-v2' }] });
    window.location.search = '?returnTo=%2Fdocs';
    render(<LoginPage mode="login" />);
    await userEvent.click(await screen.findByRole('button', { name: /sign in with google/i }));
    expect(mockAuth.login).toHaveBeenCalledWith('/docs', '/auth/google-v2');
  });

  it.each([
    ['provider_disabled', 'That sign-in method is not enabled on this instance.'],
    ['account_exists', /An account with this email already exists\. Sign in with the method you used before\./],
    ['link_invalid', /This sign-in link has expired or was already used\. Run docker compose exec app squire claim-link/],
    ['instance_claimed', /This instance already has an owner\./],
    ['claim_invalid', 'Enter a name and a valid email address.'],
  ])('error %s has its message', async (code, message) => {
    stubProviders(LOCAL_PROVIDERS);
    mockAuth = { login: vi.fn(), error: code, loading: false };
    render(<LoginPage mode="login" />);
    expect(screen.getByText(message)).toBeInTheDocument();
  });
});
