import { useTheme } from '../contexts/ThemeContext';
import './ThemeControl.css';

/**
 * ThemeControl — the Light / Dark / System appearance picker (feature 006-dark-mode).
 *
 * Renders as a labeled segmented control inside the user profile menu on
 * authenticated screens (FR-002). Selecting an option calls setSetting, which
 * restyles the app immediately with no reload and persists device-local
 * (FR-001/FR-004/SC-001). Keyboard-operable; focus is visible via --focus-ring.
 */
const OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export default function ThemeControl() {
  const { setting, setSetting } = useTheme();

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
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={setting === opt.value}
            className={
              'theme-control-option' +
              (setting === opt.value ? ' theme-control-option--active' : '')
            }
            onClick={() => setSetting(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
