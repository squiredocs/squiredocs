import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMobile } from '../useMobile';

describe('useMobile', () => {
  let originalNavigator;
  let originalUserAgent;

  beforeEach(() => {
    // Store original navigator.userAgent
    originalNavigator = window.navigator;
    originalUserAgent = navigator.userAgent;
  });

  afterEach(() => {
    // Restore original userAgent
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      writable: true,
      configurable: true,
    });
    vi.clearAllMocks();
  });

  const setUserAgent = (ua) => {
    Object.defineProperty(navigator, 'userAgent', {
      value: ua,
      writable: true,
      configurable: true,
    });
  };

  it('returns false for desktop Chrome user agent', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    const { result } = renderHook(() => useMobile());
    expect(result.current).toBe(false);
  });

  it('returns false for desktop Firefox user agent', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0');
    const { result } = renderHook(() => useMobile());
    expect(result.current).toBe(false);
  });

  it('returns false for desktop Safari user agent', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15');
    const { result } = renderHook(() => useMobile());
    expect(result.current).toBe(false);
  });

  it('returns true for iPhone user agent', () => {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1');
    const { result } = renderHook(() => useMobile());
    expect(result.current).toBe(true);
  });

  it('returns true for iPad user agent', () => {
    setUserAgent('Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1');
    const { result } = renderHook(() => useMobile());
    expect(result.current).toBe(true);
  });

  it('returns true for Android phone user agent', () => {
    setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
    const { result } = renderHook(() => useMobile());
    expect(result.current).toBe(true);
  });

  it('returns true for Android tablet user agent', () => {
    setUserAgent('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    const { result } = renderHook(() => useMobile());
    expect(result.current).toBe(true);
  });

  it('returns true for Chrome on iOS user agent', () => {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1');
    const { result } = renderHook(() => useMobile());
    expect(result.current).toBe(true);
  });

  it('returns consistent value across re-renders', () => {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1');
    const { result, rerender } = renderHook(() => useMobile());
    expect(result.current).toBe(true);

    rerender();
    expect(result.current).toBe(true);
  });
});
