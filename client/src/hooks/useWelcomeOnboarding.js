import { useEffect, useRef } from 'react';
import { useByok } from '../contexts/ByokContext';

/**
 * Onboarding: landing on the welcome doc (`?welcome=1`) opens the AI panel and
 * has the assistant greet the user via the hidden welcome kickoff. Fires exactly
 * once, then strips the flag so a refresh or back-nav doesn't re-trigger it.
 *
 * It waits until the BYOK settings load, because they carry whether the
 * assistant can answer at all. With no usable key (a self-hosted instance with no
 * server key, and no BYOK key for this user) the panel still opens, on its setup
 * state, and the kickoff is never sent: it could only fail.
 *
 * @param {object} opts
 * @param {{ view: string, docGuid: string|null }} opts.route
 * @param {Function} opts.openPanel          aiPanel.open
 * @param {Function} opts.sendWelcomeMessage aiChat.sendWelcomeMessage
 */
export function useWelcomeOnboarding({ route, openPanel, sendWelcomeMessage }) {
  const { loading: byokLoading, assistantUnavailable } = useByok();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    if (route.view !== 'editor' || !route.docGuid) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('welcome') !== '1') return;
    if (byokLoading) return;

    startedRef.current = true;
    openPanel();
    if (!assistantUnavailable) sendWelcomeMessage();

    params.delete('welcome');
    const qs = params.toString();
    window.history.replaceState({}, '', `/d/${route.docGuid}${qs ? `?${qs}` : ''}`);
  }, [route.view, route.docGuid, openPanel, sendWelcomeMessage, byokLoading, assistantUnavailable]);
}
