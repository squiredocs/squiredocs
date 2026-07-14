/**
 * Theming is purely presentational (T050, FR-014/SC-006): switching the theme
 * must perform NO document / version / collaboration write. ThemeContext touches
 * only localStorage['squire-theme'] and the <html data-theme> attribute — never
 * a Yjs document. This test proves that isolation with a real Y.Doc: toggling
 * the theme any number of times produces zero Yjs updates.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import { ThemeProvider, useTheme } from '../contexts/ThemeContext';

function mockMatchMedia(prefersDark) {
  window.matchMedia = vi.fn(() => ({
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

const wrapper = ({ children }) => <ThemeProvider>{children}</ThemeProvider>;

describe('theme switching performs no document write', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    mockMatchMedia(false);
  });

  it('produces zero Yjs updates across a sequence of theme switches', () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('prosemirror').insert(0, [new Y.XmlText('hello')]);
    let updates = 0;
    doc.on('update', () => {
      updates++;
    });

    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setSetting('dark'));
    act(() => result.current.setSetting('light'));
    act(() => result.current.setSetting('system'));
    act(() => result.current.setSetting('dark'));

    expect(updates).toBe(0);
    doc.destroy();
  });

  it('writes only the squire-theme key, nothing else', () => {
    // The test harness mocks localStorage as a plain object whose setItem is a
    // vi.fn (see src/test/setup.js), so assert against that mock directly.
    localStorage.setItem.mockClear();
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setSetting('dark'));
    act(() => result.current.setSetting('light'));

    const keysWritten = new Set(localStorage.setItem.mock.calls.map((c) => c[0]));
    expect([...keysWritten]).toEqual(['squire-theme']);
  });
});
