import { useRef } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import './ThemeControl.css';

/**
 * ThemeControl — the Light / Dark / System appearance picker (feature 006-dark-mode).
 *
 * Renders as a labeled segmented control inside the user profile menu on
 * authenticated screens (FR-002). Selecting an option calls setSetting, which
 * restyles the app immediately with no reload and persists device-local
 * (FR-001/FR-004/SC-001).
 *
 * Implements the WAI-ARIA radiogroup keyboard pattern: roving tabIndex (only
 * the checked option is a tab stop) and Arrow keys move focus AND selection
 * with wrap-around, so it behaves like a native radio group for keyboard and
 * screen-reader users. Focus is visible via --focus-ring.
 */
const OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export default function ThemeControl() {
  const { setting, setSetting } = useTheme();
  const optionRefs = useRef([]);

  // Index of the currently-selected option; the roving tab stop. If the stored
  // setting is somehow unknown, fall back to the first option being tabbable.
  const selectedIndex = Math.max(
    0,
    OPTIONS.findIndex((opt) => opt.value === setting)
  );

  // Move selection+focus to a new index, wrapping around the ends (standard
  // radio-group behavior: arrowing selects, not just focuses).
  const moveTo = (index) => {
    const count = OPTIONS.length;
    const next = ((index % count) + count) % count;
    setSetting(OPTIONS[next].value);
    optionRefs.current[next]?.focus();
  };

  const handleKeyDown = (event, index) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        moveTo(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        moveTo(index - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div className="theme-control">
      <span className="theme-control-label" id="theme-control-label">
        Appearance
      </span>
      <div
        className="theme-control-options"
        role="radiogroup"
        aria-labelledby="theme-control-label"
      >
        {OPTIONS.map((opt, index) => {
          const checked = setting === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={index === selectedIndex ? 0 : -1}
              ref={(el) => {
                optionRefs.current[index] = el;
              }}
              className={
                'theme-control-option' +
                (checked ? ' theme-control-option--active' : '')
              }
              onClick={() => setSetting(opt.value)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
