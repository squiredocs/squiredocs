/**
 * ThemeContext system-follow tests (T047, US2/FR-003): while the setting is
 * System, a live OS appearance change restyles the app; an explicit Light/Dark
 * choice ignores OS changes; switching back to System resumes following.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../ThemeContext';

/** Controllable matchMedia that can emit `change` events. */
function installMatchMedia(initialDark) {
  const listeners = new Set();
  const mql = {
    matches: initialDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_e, cb) => listeners.add(cb),
    removeEventListener: (_e, cb) => listeners.delete(cb),
    addListener: (cb) => listeners.add(cb),
    removeListener: (cb) => listeners.delete(cb),
  };
  window.matchMedia = vi.fn(() => mql);
  return {
    emit(next) {
      mql.matches = next;
      act(() => listeners.forEach((cb) => cb({ matches: next })));
    },
    listenerCount: () => listeners.size,
  };
}

const wrapper = ({ children }) => <ThemeProvider>{children}</ThemeProvider>;

describe('ThemeContext system-follow', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it('follows a live OS change while setting is System', () => {
    const mm = installMatchMedia(false);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.resolvedTheme).toBe('light');

    mm.emit(true);
    expect(result.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    mm.emit(false);
    expect(result.current.resolvedTheme).toBe('light');
  });

  it('an explicit Light choice ignores subsequent OS changes', () => {
    const mm = installMatchMedia(false);
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setSetting('light'));

    mm.emit(true); // OS goes dark
    expect(result.current.resolvedTheme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('switching back to System resumes following the OS', () => {
    const mm = installMatchMedia(true);
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => result.current.setSetting('light'));
    expect(result.current.resolvedTheme).toBe('light');

    act(() => result.current.setSetting('system'));
    // OS currently prefers dark → resumes to dark
    expect(result.current.resolvedTheme).toBe('dark');

    mm.emit(false);
    expect(result.current.resolvedTheme).toBe('light');
  });

  it('detaches the OS listener when leaving System', () => {
    const mm = installMatchMedia(false);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(mm.listenerCount()).toBe(1); // subscribed under System

    act(() => result.current.setSetting('dark'));
    expect(mm.listenerCount()).toBe(0); // detached on explicit choice
  });
});
