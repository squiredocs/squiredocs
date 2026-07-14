/**
 * Canvas-theme regression (T055 — the FLIPPED U2 check, D5 overridden + D15).
 *
 * Two guarantees:
 *  1. The document canvas THEMES DARK: under `data-theme="dark"` the `--canvas-bg`
 *     token resolves to a dark value distinct from its light value. jsdom does
 *     not resolve custom properties from injected stylesheets via
 *     getComputedStyle, so this is asserted at the token source-of-truth level by
 *     parsing index.css (the registry is the single place the flip is defined).
 *  2. Author-SET inline colors are NEVER touched by theme (D15/FR-008): an inline
 *     `style="color:#..."` on rendered content is byte-for-byte identical under
 *     both themes.
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../contexts/ThemeContext';

const indexCss = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.css'),
  'utf8'
);

/** Body of the `:root[data-theme="dark"]` realization block. */
function darkRootBody() {
  const m = indexCss.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  return m ? m[1] : '';
}
/** First value of a custom property anywhere (the light/default definition). */
function firstToken(name) {
  const m = indexCss.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}
/** Value of a custom property within a given block body. */
function tokenInBody(body, name) {
  const m = body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

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

describe('canvas themes dark (D5 overridden)', () => {
  it('--canvas-bg is defined and flips to a distinct dark value', () => {
    const light = firstToken('--canvas-bg');
    const dark = tokenInBody(darkRootBody(), '--canvas-bg');
    expect(light).toBeTruthy();
    expect(dark).toBeTruthy();
    expect(dark).not.toBe(light);
    // The dark canvas value is an explicit dark hex, not white/paper.
    expect(dark.toLowerCase()).toMatch(/^#[0-3]/); // e.g. #17191d
  });

  it('--canvas-media-plate stays light (not redefined under dark) — D16', () => {
    const body = darkRootBody().replace(/\/\*[\s\S]*?\*\//g, ''); // drop comments
    expect(body).not.toMatch(/--canvas-media-plate\s*:/); // no dark *definition*
  });
});

describe('author-set inline colors are untouched by theme (D15)', () => {
  function Harness() {
    const { setSetting } = useTheme();
    return (
      <div className="editor-common-content">
        <button onClick={() => setSetting('dark')}>dark</button>
        <button onClick={() => setSetting('light')}>light</button>
        <span data-testid="authored" style={{ color: '#123456' }}>
          authored text
        </span>
      </div>
    );
  }

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    mockMatchMedia(false);
  });

  it('keeps an author-set inline color identical across theme switches', () => {
    const { getByTestId, getByText } = render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    );
    const span = getByTestId('authored');
    const before = span.getAttribute('style');

    getByText('dark').click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(span.getAttribute('style')).toBe(before);

    getByText('light').click();
    expect(span.getAttribute('style')).toBe(before);
    expect(span.style.color).toBe('rgb(18, 52, 86)'); // #123456, unchanged
  });
});
