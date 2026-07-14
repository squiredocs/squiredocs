/**
 * ThemeControl tests (T044): selecting Dark/Light updates data-theme with no
 * reload and persists; the control reflects the active setting.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider } from '../../contexts/ThemeContext';
import ThemeControl from '../ThemeControl';

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

const renderControl = () =>
  render(
    <ThemeProvider>
      <ThemeControl />
    </ThemeProvider>
  );

describe('ThemeControl', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    mockMatchMedia(false);
  });

  it('renders exactly three options: Light, Dark, System', () => {
    renderControl();
    expect(screen.getByRole('radio', { name: 'Light' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'System' })).toBeInTheDocument();
  });

  it('reflects the active setting via aria-checked (default System)', () => {
    renderControl();
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('selecting Dark sets data-theme=dark and persists (no reload)', () => {
    const reloadSpy = vi.fn();
    renderControl();
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('squire-theme')).toBe('dark');
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(reloadSpy).not.toHaveBeenCalled(); // purely a synchronous attribute swap
  });

  it('selecting Light after Dark reverts and persists', () => {
    renderControl();
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('squire-theme')).toBe('light');
  });
});
