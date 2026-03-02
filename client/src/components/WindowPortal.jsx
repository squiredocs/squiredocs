import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders children into a popup browser window via React portal.
 * Copies stylesheets from the main document so styles work in the popup.
 *
 * Props:
 *   onOpen(popupWindow) — called with the Window object after open
 *   onClose()           — called when popup is closed (browser X or unmount)
 *   width, height       — popup dimensions (default 420x600)
 *   title               — popup document title
 */
function WindowPortal({ children, onOpen, onClose, width = 420, height = 600, title = 'AI Assistant' }) {
  const popupRef = useRef(null);
  const containerRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let popup = null;
    let pollId = null;
    let cancelled = false;

    // Defer window.open to next tick — calling it synchronously inside a
    // React commit-phase effect triggers focus/blur events that re-enter
    // the React work loop ("Should not already be working" error).
    const timerId = setTimeout(() => {
      if (cancelled) return;

      // Center the popup on screen
      const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
      const top = Math.round(window.screenY + (window.outerHeight - height) / 2);

      popup = window.open(
        '',
        '_blank',
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no`
      );

      if (!popup) {
        // Popup blocked
        onClose?.();
        return;
      }

      popupRef.current = popup;

      // Set up the popup document
      popup.document.title = title;

      // Set base href so relative stylesheet URLs resolve against the app origin
      // (the popup URL is about:blank, so relative paths like /assets/foo.css
      // would otherwise fail to load)
      const base = popup.document.createElement('base');
      base.href = window.location.origin;
      popup.document.head.appendChild(base);

      // Copy all stylesheets from main document into popup head.
      // Track <link> elements so we can wait for them to load before
      // rendering content (prevents flash of unstyled content).
      const linkLoadPromises = [];
      const mainStyles = document.querySelectorAll('style, link[rel="stylesheet"]');
      mainStyles.forEach((node) => {
        const clone = node.cloneNode(true);
        if (clone.tagName === 'LINK') {
          linkLoadPromises.push(
            new Promise((resolve) => {
              clone.addEventListener('load', resolve, { once: true });
              clone.addEventListener('error', resolve, { once: true });
            })
          );
        }
        popup.document.head.appendChild(clone);
      });

      // Hide popup body until stylesheets are ready
      popup.document.body.style.visibility = 'hidden';

      // Set up popup body styles
      popup.document.body.style.margin = '0';
      popup.document.body.style.height = '100vh';
      popup.document.body.style.overflow = 'hidden';
      popup.document.body.classList.add('ai-panel-popup-window');

      // Create container div for the portal
      const container = popup.document.createElement('div');
      container.id = 'ai-panel-portal-root';
      popup.document.body.appendChild(container);
      containerRef.current = container;

      onOpen?.(popup);

      // Wait for all external stylesheets to load, then reveal content
      Promise.all(linkLoadPromises).then(() => {
        if (cancelled || !popup || popup.closed) return;
        popup.document.body.style.visibility = '';
        setReady(true);
      });

      // Poll for popup closed by browser X button
      pollId = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollId);
          onClose?.();
        }
      }, 500);
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timerId);
      if (pollId) clearInterval(pollId);
      if (popup && !popup.closed) {
        popup.close();
      }
      popupRef.current = null;
      containerRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready || !containerRef.current) return null;

  return createPortal(children, containerRef.current);
}

export default WindowPortal;
