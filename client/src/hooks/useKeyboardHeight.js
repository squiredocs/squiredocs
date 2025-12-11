import { useState, useEffect } from 'react';

/**
 * Hook to detect virtual keyboard height on mobile devices.
 * Uses the Visual Viewport API to keep fixed elements visible above the keyboard.
 *
 * On iOS Safari, position: fixed; bottom: 0 elements get hidden behind the
 * virtual keyboard because Safari doesn't resize the layout viewport when
 * the keyboard opens. This hook provides the offset needed to position
 * elements above the keyboard.
 */
export function useKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) {
      return;
    }

    const viewport = window.visualViewport;

    const updateKeyboardHeight = () => {
      // Calculate the bottom position of the visual viewport relative to the layout viewport
      // viewport.height = visible area height (shrinks when keyboard opens)
      // viewport.offsetTop = scroll offset of visual viewport from top of layout viewport
      const bottomOffset = window.innerHeight - (viewport.height + viewport.offsetTop);

      // Only treat as keyboard if the offset is significant (> 100px)
      // This filters out minor changes from browser chrome/address bar
      setKeyboardHeight(bottomOffset > 100 ? bottomOffset : 0);
    };

    // Listen to both resize (keyboard open/close) and scroll (viewport moves while keyboard is open)
    viewport.addEventListener('resize', updateKeyboardHeight);
    viewport.addEventListener('scroll', updateKeyboardHeight);
    updateKeyboardHeight();

    return () => {
      viewport.removeEventListener('resize', updateKeyboardHeight);
      viewport.removeEventListener('scroll', updateKeyboardHeight);
    };
  }, []);

  return keyboardHeight;
}
