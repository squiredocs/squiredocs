import { useState, useEffect } from 'react';

/**
 * Hook to track the visual viewport on mobile devices.
 *
 * On iOS Safari, the layout viewport doesn't resize when the virtual keyboard opens,
 * but the visual viewport does. This hook tracks the visual viewport dimensions
 * so we can create a container that matches it exactly.
 *
 * Returns null on desktop/unsupported browsers, allowing fallback to normal behavior.
 * Also returns isKeyboardOpen to detect when the virtual keyboard is likely visible.
 */
export function useVisualViewport() {
  const [viewport, setViewport] = useState(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) {
      return;
    }

    const vv = window.visualViewport;

    const updateViewport = () => {
      // Keyboard is likely open if visual viewport is significantly smaller than window
      // Using a threshold of 150px to account for minor differences
      const isKeyboardOpen = window.innerHeight - vv.height > 150;
      
      setViewport({
        height: vv.height,
        offsetTop: vv.offsetTop,
        isKeyboardOpen,
      });
    };

    // Initialize
    updateViewport();

    // Listen to viewport changes
    vv.addEventListener('resize', updateViewport);
    vv.addEventListener('scroll', updateViewport);

    return () => {
      vv.removeEventListener('resize', updateViewport);
      vv.removeEventListener('scroll', updateViewport);
    };
  }, []);

  return viewport;
}
