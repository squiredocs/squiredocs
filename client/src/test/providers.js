/**
 * Feature 059 test helper: answer GET /auth/providers with a given body (or a
 * failure) for one test. Restore with vi.unstubAllGlobals() in afterEach.
 */
import { vi } from 'vitest';

export const LOCAL_PROVIDERS = { mode: 'local', hasOwner: true, signupOpen: false, providers: [] };
export const TEAM_PROVIDERS = {
  mode: 'team',
  hasOwner: true,
  signupOpen: true,
  providers: [{ id: 'google', label: 'Google', startPath: '/auth/google' }],
};

/**
 * @param {object|'fail'} info - the providers body, or 'fail' for a network error
 * @param {(url: string, init?: object) => Promise<any>} [other] - every other request
 */
export function stubProviders(info, other = () => Promise.reject(new Error('no network in tests'))) {
  const fetchMock = vi.fn((url, init) => {
    if (typeof url === 'string' && url.endsWith('/auth/providers')) {
      if (info === 'fail') return Promise.reject(new Error('network down'));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(info) });
    }
    return other(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
