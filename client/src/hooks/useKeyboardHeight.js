import { useState, useEffect } from 'react';

/**
 * Hook to detect virtual keyboard height on mobile devices.
 * Uses the visualViewport API to calculate the keyboard height
 * by comparing the visual viewport to the layout viewport.
 */
export function useKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) {
      return;
    }

    const viewport = window.visualViewport;

    const updateKeyboardHeight = () => {
      // The keyboard height is the difference between the window inner height
      // and the visual viewport height
      const windowHeight = window.innerHeight;
      const viewportHeight = viewport.height;

      // Calculate keyboard height
      const calculatedHeight = windowHeight - viewportHeight;

      // Only set if it's a reasonable keyboard height (> 100px)
      setKeyboardHeight(calculatedHeight > 100 ? calculatedHeight : 0);
    };

    viewport.addEventListener('resize', updateKeyboardHeight);
    updateKeyboardHeight();

    return () => {
      viewport.removeEventListener('resize', updateKeyboardHeight);
    };
  }, []);

  return keyboardHeight;
}
