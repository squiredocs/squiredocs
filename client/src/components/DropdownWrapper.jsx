import { useState, useEffect, useRef } from 'react';
import './DropdownWrapper.css';

/**
 * Reusable dropdown wrapper that handles:
 * - Open/close state
 * - Click-outside detection (excluding the trigger button)
 * - Positioning
 */
export default function DropdownWrapper({
  trigger,
  children,
  className = ''
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  const toggleOpen = (e) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  };

  const close = () => {
    setIsOpen(false);
  };

  // Click outside to close - but the trigger button is INSIDE containerRef,
  // so clicking it will toggle, not close
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        close();
      }
    };

    // Delay registration to next event loop to avoid closing from the same mousedown that opened it
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 10);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className={`dropdown-wrapper ${className}`} ref={containerRef}>
      <div onClick={toggleOpen} className="dropdown-trigger">
        {trigger(isOpen)}
      </div>
      {isOpen && (typeof children === 'function' ? children(close) : children)}
    </div>
  );
}
