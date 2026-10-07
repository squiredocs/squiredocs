/**
 * The instance's sign-in providers (feature 059, contracts/pages.md,
 * RBD-059-21).
 *
 * One GET /auth/providers per page load, shared by every component that asks
 * (a module-level promise). Returns { status, info }:
 *   status 'loading' until the request settles, then 'ready' or 'error';
 *   info   the server's { mode, hasOwner, signupOpen, providers }, or, on any
 *          failure (network, non-200, unexpected shape), the team-mode Google
 *          fallback, because that is the hosted page and the hosted service
 *          must never show a blank sign-in page.
 */
import { useEffect, useState } from 'react';

export const GOOGLE_FALLBACK = Object.freeze({
  mode: 'team',
  hasOwner: true,
  signupOpen: true,
  providers: Object.freeze([Object.freeze({ id: 'google', label: 'Google', startPath: '/auth/google' })]),
});

let shared = null; // Promise<{ status, info }>
let settled = null; // the settled value, for synchronous first renders

function isProviderInfo(v) {
  return !!v
    && (v.mode === 'local' || v.mode === 'team')
    && Array.isArray(v.providers)
    && v.providers.every((p) => p && typeof p.id === 'string' && typeof p.label === 'string' && typeof p.startPath === 'string');
}

export function loadAuthProviders() {
  if (!shared) {
    shared = Promise.resolve()
      .then(() => fetch('/auth/providers', { credentials: 'same-origin' }))
      .then((res) => {
        if (!res || (res.ok === false)) throw new Error('providers request failed');
        return res.json();
      })
      .then((info) => {
        if (!isProviderInfo(info)) throw new Error('unexpected providers response');
        return { status: 'ready', info };
      })
      .catch(() => ({ status: 'error', info: GOOGLE_FALLBACK }))
      .then((value) => {
        settled = value;
        return value;
      });
  }
  return shared;
}

/** Test-only: forget the shared result so the next render fetches again. */
export function _resetAuthProvidersForTests() {
  shared = null;
  settled = null;
}

export default function useAuthProviders() {
  const [state, setState] = useState(() => settled || { status: 'loading', info: null });
  useEffect(() => {
    let cancelled = false;
    loadAuthProviders().then((value) => {
      if (!cancelled) setState(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
