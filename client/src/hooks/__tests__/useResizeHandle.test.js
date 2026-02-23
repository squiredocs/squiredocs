import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useResizeHandle } from '../useResizeHandle';

describe('useResizeHandle', () => {
  let onResize;

  beforeEach(() => {
    onResize = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts with isDragging false', () => {
    const { result } = renderHook(() =>
      useResizeHandle('horizontal', onResize, 200, 600)
    );
    expect(result.current.isDragging).toBe(false);
  });

  it('horizontal drag calls onResize with clamped value', () => {
    const { result } = renderHook(() =>
      useResizeHandle('horizontal', onResize, 200, 600)
    );

    // Start drag at clientX=500 with current size 400
    act(() => {
      result.current.handleMouseDown({ preventDefault: vi.fn(), clientX: 500, clientY: 0 }, 400);
    });

    expect(result.current.isDragging).toBe(true);

    // Move mouse left to clientX=450 → delta = 500 - 450 = 50 → newSize = 400 + 50 = 450
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 450, clientY: 0 }));
    });

    expect(onResize).toHaveBeenCalledWith(450);
  });

  it('vertical drag calls onResize with clamped value', () => {
    const { result } = renderHook(() =>
      useResizeHandle('vertical', onResize, 100, 500)
    );

    // Start drag at clientY=400 with current size 250
    act(() => {
      result.current.handleMouseDown({ preventDefault: vi.fn(), clientX: 0, clientY: 400 }, 250);
    });

    // Move mouse up to clientY=350 → delta = 400 - 350 = 50 → newSize = 250 + 50 = 300
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 350 }));
    });

    expect(onResize).toHaveBeenCalledWith(300);
  });

  it('clamps to minimum size', () => {
    const { result } = renderHook(() =>
      useResizeHandle('horizontal', onResize, 200, 600)
    );

    act(() => {
      result.current.handleMouseDown({ preventDefault: vi.fn(), clientX: 300, clientY: 0 }, 250);
    });

    // Move mouse right past start → delta = 300 - 500 = -200 → newSize = 250 + (-200) = 50 → clamped to 200
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 0 }));
    });

    expect(onResize).toHaveBeenCalledWith(200);
  });

  it('clamps to maximum size', () => {
    const { result } = renderHook(() =>
      useResizeHandle('horizontal', onResize, 200, 600)
    );

    act(() => {
      result.current.handleMouseDown({ preventDefault: vi.fn(), clientX: 500, clientY: 0 }, 500);
    });

    // Move mouse far left → delta = 500 - 100 = 400 → newSize = 500 + 400 = 900 → clamped to 600
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 0 }));
    });

    expect(onResize).toHaveBeenCalledWith(600);
  });

  it('mouseup ends dragging', () => {
    const { result } = renderHook(() =>
      useResizeHandle('horizontal', onResize, 200, 600)
    );

    act(() => {
      result.current.handleMouseDown({ preventDefault: vi.fn(), clientX: 500, clientY: 0 }, 400);
    });

    expect(result.current.isDragging).toBe(true);

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'));
    });

    expect(result.current.isDragging).toBe(false);
  });

  it('touch events work for drag', () => {
    const { result } = renderHook(() =>
      useResizeHandle('horizontal', onResize, 200, 600)
    );

    act(() => {
      result.current.handleTouchStart({ touches: [{ clientX: 500, clientY: 0 }] }, 400);
    });

    expect(result.current.isDragging).toBe(true);

    act(() => {
      const touchMoveEvent = new Event('touchmove');
      touchMoveEvent.touches = [{ clientX: 460, clientY: 0 }];
      document.dispatchEvent(touchMoveEvent);
    });

    expect(onResize).toHaveBeenCalledWith(440);

    act(() => {
      document.dispatchEvent(new Event('touchend'));
    });

    expect(result.current.isDragging).toBe(false);
  });

  it('sets cursor and user-select during drag, restores on end', () => {
    const { result } = renderHook(() =>
      useResizeHandle('horizontal', onResize, 200, 600)
    );

    const originalUserSelect = document.body.style.userSelect;
    const originalCursor = document.body.style.cursor;

    act(() => {
      result.current.handleMouseDown({ preventDefault: vi.fn(), clientX: 500, clientY: 0 }, 400);
    });

    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'));
    });

    expect(document.body.style.userSelect).toBe(originalUserSelect);
    expect(document.body.style.cursor).toBe(originalCursor);
  });
});
