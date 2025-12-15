import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVisualViewport } from '../useVisualViewport';

describe('useVisualViewport', () => {
  let mockVisualViewport;
  let resizeHandler;
  let scrollHandler;
  let originalVisualViewport;

  beforeEach(() => {
    // Store original
    originalVisualViewport = window.visualViewport;

    // Create mock visual viewport
    mockVisualViewport = {
      height: 800,
      offsetTop: 0,
      addEventListener: vi.fn((event, handler) => {
        if (event === 'resize') resizeHandler = handler;
        if (event === 'scroll') scrollHandler = handler;
      }),
      removeEventListener: vi.fn(),
    };

    // Set up the mock
    Object.defineProperty(window, 'visualViewport', {
      value: mockVisualViewport,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    // Restore original
    Object.defineProperty(window, 'visualViewport', {
      value: originalVisualViewport,
      writable: true,
      configurable: true,
    });
    vi.clearAllMocks();
  });

  it('returns null when visualViewport is not available', () => {
    Object.defineProperty(window, 'visualViewport', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useVisualViewport());
    expect(result.current).toBeNull();
  });

  it('returns initial viewport dimensions', () => {
    const { result } = renderHook(() => useVisualViewport());

    expect(result.current).toEqual({
      height: 800,
      offsetTop: 0,
    });
  });

  it('subscribes to resize and scroll events', () => {
    renderHook(() => useVisualViewport());

    expect(mockVisualViewport.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(mockVisualViewport.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('updates when viewport resizes (keyboard opens)', () => {
    const { result } = renderHook(() => useVisualViewport());

    // Simulate keyboard opening (viewport shrinks)
    mockVisualViewport.height = 400;
    mockVisualViewport.offsetTop = 0;

    act(() => {
      resizeHandler();
    });

    expect(result.current).toEqual({
      height: 400,
      offsetTop: 0,
    });
  });

  it('updates when viewport scrolls', () => {
    const { result } = renderHook(() => useVisualViewport());

    // Simulate viewport scroll
    mockVisualViewport.offsetTop = 50;

    act(() => {
      scrollHandler();
    });

    expect(result.current).toEqual({
      height: 800,
      offsetTop: 50,
    });
  });

  it('cleans up event listeners on unmount', () => {
    const { unmount } = renderHook(() => useVisualViewport());

    unmount();

    expect(mockVisualViewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(mockVisualViewport.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('tracks both height and offsetTop changes together', () => {
    const { result } = renderHook(() => useVisualViewport());

    // Simulate keyboard opening with some scroll offset
    mockVisualViewport.height = 350;
    mockVisualViewport.offsetTop = 100;

    act(() => {
      resizeHandler();
    });

    expect(result.current).toEqual({
      height: 350,
      offsetTop: 100,
    });
  });
});
