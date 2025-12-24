import { useEffect } from 'react';
import { useMobile } from './useMobile';

/**
 * Prevents page-level scrolling on mobile devices
 * Ensures only the editor container can scroll, preventing
 * the page from scrolling during text selection or other interactions
 */
export function usePreventPageScroll() {
  const isMobile = useMobile();

  useEffect(() => {
    if (!isMobile) return;

    const preventScroll = (e) => {
      // Reset any scroll on window
      window.scrollTo(0, 0);
    };

    // Listen for scroll events on window and reset immediately
    window.addEventListener('scroll', preventScroll, { passive: false });

    // Also ensure scroll position stays at 0
    const interval = setInterval(() => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }
    }, 100);

    // Initial reset
    window.scrollTo(0, 0);

    return () => {
      window.removeEventListener('scroll', preventScroll);
      clearInterval(interval);
    };
  }, [isMobile]);
}
