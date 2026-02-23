import { useState, useCallback, useEffect, useRef } from 'react';

/**
 * Custom hook for desktop panel edge resizing (mouse + touch).
 *
 * @param {'horizontal'|'vertical'} direction - resize axis
 * @param {(newSize: number) => void} onResize - called with clamped size
 * @param {number} minSize - minimum allowed size in px
 * @param {number} maxSize - maximum allowed size in px
 */
export function useResizeHandle(direction, onResize, minSize, maxSize) {
  const [isDragging, setIsDragging] = useState(false);
  const startRef = useRef({ pos: 0, size: 0 });

  const handleStart = useCallback((clientPos, currentSize) => {
    startRef.current = { pos: clientPos, size: currentSize };
    setIsDragging(true);
  }, []);

  const handleMouseDown = useCallback((e, currentSize) => {
    e.preventDefault();
    const pos = direction === 'horizontal' ? e.clientX : e.clientY;
    handleStart(pos, currentSize);
  }, [direction, handleStart]);

  const handleTouchStart = useCallback((e, currentSize) => {
    const touch = e.touches[0];
    const pos = direction === 'horizontal' ? touch.clientX : touch.clientY;
    handleStart(pos, currentSize);
  }, [direction, handleStart]);

  useEffect(() => {
    if (!isDragging) return;

    // Prevent text selection and set cursor during drag
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';

    const onMove = (clientPos) => {
      const delta = startRef.current.pos - clientPos;
      const newSize = Math.min(maxSize, Math.max(minSize, startRef.current.size + delta));
      onResize(newSize);
    };

    const onMouseMove = (e) => {
      onMove(direction === 'horizontal' ? e.clientX : e.clientY);
    };

    const onTouchMove = (e) => {
      const touch = e.touches[0];
      onMove(direction === 'horizontal' ? touch.clientX : touch.clientY);
    };

    const onEnd = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onEnd);

    return () => {
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onEnd);
    };
  }, [isDragging, direction, minSize, maxSize, onResize]);

  return { handleMouseDown, handleTouchStart, isDragging };
}
