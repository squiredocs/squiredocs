/**
 * Client runtime configuration bootstrap (feature 021, DR-2).
 *
 * Fetches GET /api/client-config once per app session (after auth) and
 * publishes the binding-hardening kill-switch onto
 * `globalThis.__SQUIRE_COLLAB_HARDENING__`, where the patched
 * @tiptap/y-tiptap binding reads it LIVE at every decision point.
 *
 * Fail-safe default ON: on fetch failure (or before the fetch resolves) the
 * global stays unset, and the patch treats anything other than the explicit
 * boolean `false` as hardened. Flip semantics: at most a page refresh for a
 * server-side flip to take effect (live reads mean open tabs may pick it up
 * sooner — bonus, not contract).
 */
import { useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { registerSkipReporter } from '../utils/skipReporter';

export default function useClientConfig() {
  const { api, isAuthenticated } = useAuth();

  // Feature 021 (DR-3): install the render-skip beacon as the patch's global
  // hook. Independent of the kill-switch — the channel stays live even when
  // the hardened behaviors are reverted (stock then produces no skip events).
  useEffect(() => {
    if (!isAuthenticated) return;
    if (typeof globalThis.__SQUIRE_SKIP_REPORTER__ !== 'function') {
      registerSkipReporter(api);
    }
  }, [api, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return undefined;
    let cancelled = false;
    api
      .get('/api/client-config')
      .then((res) => {
        if (cancelled) return;
        const value = res && res.data && res.data.collabBindingHardening;
        if (typeof value === 'boolean') {
          globalThis.__SQUIRE_COLLAB_HARDENING__ = value;
        }
        // Non-boolean shapes are ignored — global stays unset => hardened.
      })
      .catch(() => {
        // Fail-safe: leave the global unset — the binding runs hardened.
      });
    return () => {
      cancelled = true;
    };
  }, [api, isAuthenticated]);
}
