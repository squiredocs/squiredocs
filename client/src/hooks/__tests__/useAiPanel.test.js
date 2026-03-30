import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAiPanel } from '../useAiPanel';

describe('useAiPanel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns correct initial state', () => {
    const { result } = renderHook(() => useAiPanel());

    expect(result.current.isOpen).toBe(false);
    expect(result.current.position).toBe('right');
    expect(result.current.widthPx).toBe(380);
    expect(result.current.heightPx).toBe(300);
  });

  it('toggle opens and closes the panel', () => {
    const { result } = renderHook(() => useAiPanel());

    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(true);

    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(false);
  });

  it('setIsOpen controls open state directly', () => {
    const { result } = renderHook(() => useAiPanel());

    act(() => result.current.setIsOpen(true));
    expect(result.current.isOpen).toBe(true);

    act(() => result.current.setIsOpen(false));
    expect(result.current.isOpen).toBe(false);
  });

  it('setPosition updates position and persists to localStorage', () => {
    const { result } = renderHook(() => useAiPanel());

    act(() => result.current.setPosition('bottom'));
    expect(result.current.position).toBe('bottom');

    const stored = JSON.parse(localStorage.getItem('aiPanelPrefs'));
    expect(stored.position).toBe('bottom');
  });

  it('updateWidth updates width and persists to localStorage', () => {
    const { result } = renderHook(() => useAiPanel());

    act(() => result.current.updateWidth(500));
    expect(result.current.widthPx).toBe(500);

    const stored = JSON.parse(localStorage.getItem('aiPanelPrefs'));
    expect(stored.widthPx).toBe(500);
  });

  it('updateHeight updates height and persists to localStorage', () => {
    const { result } = renderHook(() => useAiPanel());

    act(() => result.current.updateHeight(400));
    expect(result.current.heightPx).toBe(400);

    const stored = JSON.parse(localStorage.getItem('aiPanelPrefs'));
    expect(stored.heightPx).toBe(400);
  });

  it('loads persisted preferences on init', () => {
    localStorage.setItem('aiPanelPrefs', JSON.stringify({
      position: 'bottom',
      widthPx: 450,
      heightPx: 350,
    }));

    const { result } = renderHook(() => useAiPanel());

    expect(result.current.position).toBe('bottom');
    expect(result.current.widthPx).toBe(450);
    expect(result.current.heightPx).toBe(350);
    // isOpen is never persisted
    expect(result.current.isOpen).toBe(false);
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('aiPanelPrefs', 'not-json');

    const { result } = renderHook(() => useAiPanel());

    // Falls back to defaults
    expect(result.current.position).toBe('right');
    expect(result.current.widthPx).toBe(380);
  });

  it('close sets isOpen to false', () => {
    const { result } = renderHook(() => useAiPanel());

    act(() => result.current.toggle());
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
  });
});
