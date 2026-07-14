/**
 * ThemeContext unit tests (T009) — resolution truth table, persistence
 * round-trip, defensive read, and attribute reconciliation (data-model.md).
 * Live OS-follow behavior is covered separately in ThemeContext.system.test.jsx.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  ThemeProvider,
  useTheme,
  resolve,
  readStoredSetting,
} from '../ThemeContext';

/** Install a controllable matchMedia mock. */
function mockMatchMedia(prefersDark) {
  const listeners = new Set();
  const mql = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_e, cb) => listeners.add(cb),
    removeEventListener: (_e, cb) => listeners.delete(cb),
    addListener: (cb) => listeners.add(cb),
    removeListener: (cb) => listeners.delete(cb),
    _emit(next) {
      this.matches = next;
      listeners.forEach((cb) => cb({ matches: next }));
    },
  };
  window.matchMedia = vi.fn(() => mql);
  return mql;
}

const wrapper = ({ children }) => <ThemeProvider>{children}</ThemeProvider>;

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    mockMatchMedia(false);
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  describe('resolve() truth table', () => {
    it.each([
      ['light', true, 'light'],
      ['light', false, 'light'],
      ['dark', true, 'dark'],
      ['dark', false, 'dark'],
      ['system', true, 'dark'],
      ['system', false, 'light'],
      ['bogus', true, 'dark'], // unknown follows OS like system
      ['bogus', false, 'light'],
    ])('resolve(%s, prefersDark=%s) → %s', (setting, prefersDark, expected) => {
      expect(resolve(setting, prefersDark)).toBe(expected);
    });
  });

  describe('readStoredSetting() defensive read', () => {
    it('returns system when nothing is stored', () => {
      expect(readStoredSetting()).toBe('system');
    });
    it('returns system for an unrecognized stored value', () => {
      localStorage.setItem('squire-theme', 'neon');
      expect(readStoredSetting()).toBe('system');
    });
    it('returns the stored value when valid', () => {
      localStorage.setItem('squire-theme', 'dark');
      expect(readStoredSetting()).toBe('dark');
    });
  });

  describe('provider default', () => {
    it('defaults to system with no stored preference', () => {
      const { result } = renderHook(() => useTheme(), { wrapper });
      expect(result.current.setting).toBe('system');
    });

    it('resolves system→light when OS is light and stamps the attribute', () => {
      mockMatchMedia(false);
      const { result } = renderHook(() => useTheme(), { wrapper });
      expect(result.current.resolvedTheme).toBe('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('resolves system→dark when OS is dark', () => {
      mockMatchMedia(true);
      const { result } = renderHook(() => useTheme(), { wrapper });
      expect(result.current.resolvedTheme).toBe('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  describe('setSetting() persistence round-trip + attribute reconciliation', () => {
    it('persists an explicit Dark choice and updates data-theme, no reload', () => {
      const { result } = renderHook(() => useTheme(), { wrapper });
      act(() => result.current.setSetting('dark'));
      expect(result.current.setting).toBe('dark');
      expect(result.current.resolvedTheme).toBe('dark');
      expect(localStorage.getItem('squire-theme')).toBe('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('explicit Light wins over an OS dark preference', () => {
      mockMatchMedia(true);
      const { result } = renderHook(() => useTheme(), { wrapper });
      act(() => result.current.setSetting('light'));
      expect(result.current.resolvedTheme).toBe('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('round-trips: a persisted choice is read back by a fresh provider', () => {
      const first = renderHook(() => useTheme(), { wrapper });
      act(() => first.result.current.setSetting('dark'));
      first.unmount();

      const second = renderHook(() => useTheme(), { wrapper });
      expect(second.result.current.setting).toBe('dark');
      expect(second.result.current.resolvedTheme).toBe('dark');
    });

    it('coerces an invalid setSetting argument to system', () => {
      const { result } = renderHook(() => useTheme(), { wrapper });
      act(() => result.current.setSetting('rainbow'));
      expect(result.current.setting).toBe('system');
      expect(localStorage.getItem('squire-theme')).toBe('system');
    });
  });

  describe('useTheme() guard', () => {
    it('throws when used outside a ThemeProvider', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => renderHook(() => useTheme())).toThrow(
        'useTheme must be used within a ThemeProvider'
      );
      spy.mockRestore();
    });
  });
});
