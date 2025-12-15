import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMobile } from '../useMobile';

describe('useMobile', () => {
  let mockMatchMedia;
  let changeHandler;
  let originalMatchMedia;

  beforeEach(() => {
    // Store original
    originalMatchMedia = window.matchMedia;
    changeHandler = null;

    // Create mock matchMedia
    mockMatchMedia = vi.fn((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn((event, handler) => {
        if (event === 'change') changeHandler = handler;
      }),
      removeEventListener: vi.fn(),
    }));

    window.matchMedia = mockMatchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.clearAllMocks();
  });

  it('returns false when viewport is wider than 768px', () => {
    mockMatchMedia.mockReturnValue({
      matches: false,
      media: '(max-width: 768px)',
      addEventListener: vi.fn((event, handler) => {
        if (event === 'change') changeHandler = handler;
      }),
      removeEventListener: vi.fn(),
    });

    const { result } = renderHook(() => useMobile());
    expect(result.current).toBe(false);
  });

  it('returns true when viewport is 768px or narrower', () => {
    mockMatchMedia.mockReturnValue({
      matches: true,
      media: '(max-width: 768px)',
      addEventListener: vi.fn((event, handler) => {
        if (event === 'change') changeHandler = handler;
      }),
      removeEventListener: vi.fn(),
    });

    const { result } = renderHook(() => useMobile());
    expect(result.current).toBe(true);
  });

  it('queries the correct breakpoint', () => {
    renderHook(() => useMobile());
    expect(mockMatchMedia).toHaveBeenCalledWith('(max-width: 768px)');
  });

  it('subscribes to media query changes', () => {
    const addEventListenerMock = vi.fn((event, handler) => {
      if (event === 'change') changeHandler = handler;
    });

    mockMatchMedia.mockReturnValue({
      matches: false,
      media: '(max-width: 768px)',
      addEventListener: addEventListenerMock,
      removeEventListener: vi.fn(),
    });

    renderHook(() => useMobile());
    expect(addEventListenerMock).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('updates when viewport crosses breakpoint', () => {
    const addEventListenerMock = vi.fn((event, handler) => {
      if (event === 'change') changeHandler = handler;
    });

    mockMatchMedia.mockReturnValue({
      matches: false,
      media: '(max-width: 768px)',
      addEventListener: addEventListenerMock,
      removeEventListener: vi.fn(),
    });

    const { result } = renderHook(() => useMobile());
    expect(result.current).toBe(false);

    // Simulate viewport shrinking below 768px
    act(() => {
      changeHandler({ matches: true });
    });

    expect(result.current).toBe(true);
  });

  it('updates when viewport expands above breakpoint', () => {
    const addEventListenerMock = vi.fn((event, handler) => {
      if (event === 'change') changeHandler = handler;
    });

    mockMatchMedia.mockReturnValue({
      matches: true,
      media: '(max-width: 768px)',
      addEventListener: addEventListenerMock,
      removeEventListener: vi.fn(),
    });

    const { result } = renderHook(() => useMobile());
    expect(result.current).toBe(true);

    // Simulate viewport expanding above 768px
    act(() => {
      changeHandler({ matches: false });
    });

    expect(result.current).toBe(false);
  });

  it('cleans up event listener on unmount', () => {
    const removeEventListenerMock = vi.fn();

    mockMatchMedia.mockReturnValue({
      matches: false,
      media: '(max-width: 768px)',
      addEventListener: vi.fn((event, handler) => {
        if (event === 'change') changeHandler = handler;
      }),
      removeEventListener: removeEventListenerMock,
    });

    const { unmount } = renderHook(() => useMobile());
    unmount();

    expect(removeEventListenerMock).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
