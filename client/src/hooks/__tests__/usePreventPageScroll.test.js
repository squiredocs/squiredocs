import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePreventPageScroll } from '../usePreventPageScroll';
import * as useMobileModule from '../useMobile';

describe('usePreventPageScroll', () => {
  let mockScrollTo;
  let mockAddEventListener;
  let mockRemoveEventListener;
  let mockSetInterval;
  let mockClearInterval;
  let scrollHandler;
  let intervalCallback;
  let intervalId;

  beforeEach(() => {
    // Mock window.scrollTo
    mockScrollTo = vi.fn();
    window.scrollTo = mockScrollTo;

    // Mock window scroll properties
    Object.defineProperty(window, 'scrollY', {
      writable: true,
      value: 0,
    });
    Object.defineProperty(window, 'scrollX', {
      writable: true,
      value: 0,
    });

    // Mock window.addEventListener/removeEventListener
    scrollHandler = null;
    mockAddEventListener = vi.fn((event, handler, options) => {
      if (event === 'scroll') scrollHandler = handler;
    });
    mockRemoveEventListener = vi.fn();
    window.addEventListener = mockAddEventListener;
    window.removeEventListener = mockRemoveEventListener;

    // Mock setInterval/clearInterval
    intervalCallback = null;
    intervalId = 123;
    mockSetInterval = vi.fn((callback, delay) => {
      intervalCallback = callback;
      return intervalId;
    });
    mockClearInterval = vi.fn();
    global.setInterval = mockSetInterval;
    global.clearInterval = mockClearInterval;

    // Mock useMobile hook
    vi.spyOn(useMobileModule, 'useMobile');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('on desktop (not mobile)', () => {
    beforeEach(() => {
      useMobileModule.useMobile.mockReturnValue(false);
    });

    it('does not add scroll event listener', () => {
      renderHook(() => usePreventPageScroll());
      expect(mockAddEventListener).not.toHaveBeenCalled();
    });

    it('does not set up interval', () => {
      renderHook(() => usePreventPageScroll());
      expect(mockSetInterval).not.toHaveBeenCalled();
    });

    it('does not call window.scrollTo', () => {
      renderHook(() => usePreventPageScroll());
      expect(mockScrollTo).not.toHaveBeenCalled();
    });
  });

  describe('on mobile', () => {
    beforeEach(() => {
      useMobileModule.useMobile.mockReturnValue(true);
    });

    it('adds scroll event listener on mount', () => {
      renderHook(() => usePreventPageScroll());
      
      expect(mockAddEventListener).toHaveBeenCalledWith(
        'scroll',
        expect.any(Function),
        { passive: false }
      );
    });

    it('sets up interval to check scroll position', () => {
      renderHook(() => usePreventPageScroll());
      
      expect(mockSetInterval).toHaveBeenCalledWith(
        expect.any(Function),
        100
      );
    });

    it('calls window.scrollTo(0, 0) initially on mount', () => {
      renderHook(() => usePreventPageScroll());
      
      expect(mockScrollTo).toHaveBeenCalledWith(0, 0);
    });

    it('resets scroll position when scroll event fires', () => {
      renderHook(() => usePreventPageScroll());
      
      // Clear the initial scrollTo call
      mockScrollTo.mockClear();
      
      // Trigger scroll event
      expect(scrollHandler).toBeDefined();
      scrollHandler();
      
      expect(mockScrollTo).toHaveBeenCalledWith(0, 0);
    });

    it('resets scroll position via interval when Y position changes', () => {
      renderHook(() => usePreventPageScroll());
      
      // Clear the initial scrollTo call
      mockScrollTo.mockClear();
      
      // Simulate scroll position change
      window.scrollY = 100;
      
      // Trigger interval callback
      expect(intervalCallback).toBeDefined();
      intervalCallback();
      
      expect(mockScrollTo).toHaveBeenCalledWith(0, 0);
    });

    it('resets scroll position via interval when X position changes', () => {
      renderHook(() => usePreventPageScroll());
      
      // Clear the initial scrollTo call
      mockScrollTo.mockClear();
      
      // Simulate scroll position change
      window.scrollX = 50;
      
      // Trigger interval callback
      expect(intervalCallback).toBeDefined();
      intervalCallback();
      
      expect(mockScrollTo).toHaveBeenCalledWith(0, 0);
    });

    it('does not call scrollTo via interval if position is already at origin', () => {
      renderHook(() => usePreventPageScroll());
      
      // Clear the initial scrollTo call
      mockScrollTo.mockClear();
      
      // Ensure scroll position is at origin
      window.scrollY = 0;
      window.scrollX = 0;
      
      // Trigger interval callback
      intervalCallback();
      
      expect(mockScrollTo).not.toHaveBeenCalled();
    });

    it('removes scroll event listener on unmount', () => {
      const { unmount } = renderHook(() => usePreventPageScroll());
      
      unmount();
      
      expect(mockRemoveEventListener).toHaveBeenCalledWith(
        'scroll',
        expect.any(Function)
      );
    });

    it('clears interval on unmount', () => {
      const { unmount } = renderHook(() => usePreventPageScroll());
      
      unmount();
      
      expect(mockClearInterval).toHaveBeenCalledWith(intervalId);
    });

    it('re-initializes when isMobile changes from false to true', () => {
      useMobileModule.useMobile.mockReturnValue(false);
      
      const { rerender } = renderHook(() => usePreventPageScroll());
      
      // Verify no setup on desktop
      expect(mockAddEventListener).not.toHaveBeenCalled();
      
      // Change to mobile
      useMobileModule.useMobile.mockReturnValue(true);
      rerender();
      
      // Verify setup on mobile
      expect(mockAddEventListener).toHaveBeenCalledWith(
        'scroll',
        expect.any(Function),
        { passive: false }
      );
      expect(mockSetInterval).toHaveBeenCalled();
      expect(mockScrollTo).toHaveBeenCalledWith(0, 0);
    });

    it('cleans up when isMobile changes from true to false', () => {
      useMobileModule.useMobile.mockReturnValue(true);
      
      const { rerender } = renderHook(() => usePreventPageScroll());
      
      // Verify setup on mobile
      expect(mockAddEventListener).toHaveBeenCalled();
      expect(mockSetInterval).toHaveBeenCalled();
      
      // Clear mocks
      mockRemoveEventListener.mockClear();
      mockClearInterval.mockClear();
      
      // Change to desktop
      useMobileModule.useMobile.mockReturnValue(false);
      rerender();
      
      // Verify cleanup
      expect(mockRemoveEventListener).toHaveBeenCalled();
      expect(mockClearInterval).toHaveBeenCalled();
    });
  });
});
