/**
 * Feature 059 (T038, FR-027, FR-028, RBD-059-20): the claim page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ClaimPage from '../ClaimPage';

vi.mock('../../components/Logo', () => ({ default: () => <div data-testid="logo" /> }));

const TOKEN = 'A'.repeat(20) + '_-' + 'b'.repeat(21); // 43 chars

function setLocation({ hash = '', search = '' } = {}) {
  window.location.pathname = '/claim';
  window.location.hash = hash;
  window.location.search = search;
}

function stubPeek(body) {
  const fetchMock = vi.fn((url, init) => {
    if (url === '/auth/signin-link/peek') return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ClaimPage', () => {
  let replaceState;
  beforeEach(() => {
    replaceState = vi.fn();
    window.history.replaceState = replaceState;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('removes the fragment after load, and no request URL carries the token', async () => {
    setLocation({ hash: `#${TOKEN}` });
    const fetchMock = stubPeek({ valid: true, kind: 'claim', expiresAt: 'x', prefill: { name: 'Sam', email: 'sam@example.com' } });
    render(<ClaimPage />);
    await screen.findByText('Create the owner account');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/claim');
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain(TOKEN);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ token: TOKEN });
    }
  });

  it('claim: prefilled, editable fields and a real form post with the hidden token', async () => {
    setLocation({ hash: `#${TOKEN}` });
    stubPeek({ valid: true, kind: 'claim', expiresAt: 'x', prefill: { name: 'Sam', email: 'sam@example.com' } });
    const { container } = render(<ClaimPage />);
    const name = await screen.findByLabelText('Name');
    const email = screen.getByLabelText('Email');
    expect(name).toHaveValue('Sam');
    expect(email).toHaveValue('sam@example.com');
    fireEvent.change(name, { target: { value: 'Samuel' } });
    expect(name).toHaveValue('Samuel');
    const form = container.querySelector('form');
    expect(form.getAttribute('method')).toBe('post');
    expect(form.getAttribute('action')).toBe('/auth/signin-link');
    expect(container.querySelector('input[type="hidden"][name="token"]').value).toBe(TOKEN);
  });

  it('sign-in link: "Sign in as <name> (<email>)" and no fields', async () => {
    setLocation({ hash: `#${TOKEN}` });
    stubPeek({ valid: true, kind: 'signin', expiresAt: 'x', prefill: { name: 'Owner', email: 'owner@example.com' } });
    const { container } = render(<ClaimPage />);
    expect(await screen.findByText('Sign in as Owner (owner@example.com)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(container.querySelector('input[type="hidden"][name="token"]').value).toBe(TOKEN);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('an invalid link shows the message and no form', async () => {
    setLocation({ hash: `#${TOKEN}` });
    stubPeek({ valid: false });
    const { container } = render(<ClaimPage />);
    expect(await screen.findByText(/expired or was already used\. Run docker compose exec app squire claim-link/)).toBeInTheDocument();
    expect(container.querySelector('form')).toBeNull();
  });

  it('no fragment (or a malformed one): the instruction, no request, no form', () => {
    setLocation({ hash: '#not a token' });
    const fetchMock = stubPeek({ valid: true });
    const { container } = render(<ClaimPage />);
    expect(screen.getByText('docker compose exec app squire claim-link')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('form')).toBeNull();
  });

  it('?error=claim_invalid without a fragment explains and asks to reopen the link', () => {
    setLocation({ search: '?error=claim_invalid' });
    stubPeek({ valid: true });
    render(<ClaimPage />);
    expect(screen.getByText(/Enter a name and a valid email address, then open the link from your terminal again\./)).toBeInTheDocument();
  });

  it('an empty name or a malformed email blocks submission client-side', async () => {
    setLocation({ hash: `#${TOKEN}` });
    stubPeek({ valid: true, kind: 'claim', expiresAt: 'x', prefill: { name: null, email: null } });
    const { container } = render(<ClaimPage />);
    await screen.findByLabelText('Name');
    const form = container.querySelector('form');

    let submitted = fireEvent.submit(form);
    expect(submitted).toBe(false); // default prevented
    expect(screen.getByText('Enter a name and a valid email address.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sam' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    submitted = fireEvent.submit(form);
    expect(submitted).toBe(false);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    submitted = fireEvent.submit(form);
    expect(submitted).toBe(true);
  });
});
