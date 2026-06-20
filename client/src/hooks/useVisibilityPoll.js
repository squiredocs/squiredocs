import { useEffect, useRef } from 'react';

/**
 * Poll `callback` every `intervalMs` while the tab is visible, and also fire it
 * immediately when the tab becomes visible again. Skips ticks while the tab is
 * hidden. The latest `callback` is always used (held in a ref), so the interval
 * isn't torn down and recreated when the callback identity changes.
 *
 * @param {() => void} callback     work to run on each visible tick
 * @param {number}     intervalMs   poll interval in milliseconds
 * @param {boolean}    [enabled]    when false, no polling is set up
 */
export function useVisibilityPoll(callback, intervalMs, enabled = true) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return undefined;
    const tick = () => { if (!document.hidden) callbackRef.current(); };
    const id = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [intervalMs, enabled]);
}
