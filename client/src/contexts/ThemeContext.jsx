/**
 * ThemeContext — the runtime owner of the appearance setting (feature 006-dark-mode).
 *
 * Tri-state `setting` (light | dark | system, default system) persisted
 * device-local in localStorage['squire-theme']; a derived binary `resolvedTheme`
 * (light | dark) is stamped on <html data-theme>. CSS keys ONLY on the resolved
 * attribute. The inline bootstrap in index.html already set the attribute before
 * first paint (no-flash, FR-005); this context reconciles from storage on mount
 * without causing a redundant swap, owns the setter, and — while the setting is
 * `system` — follows the OS live via matchMedia (US2/T045).
 *
 * Contracts: specs/006-dark-mode/contracts/theme-control.md, data-model.md.
 * Invariant (FR-014): theming is purely presentational — it performs NO
 * document / version / collaboration write.
 */
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from 'react';

const STORAGE_KEY = 'squire-theme';
const VALID_SETTINGS = ['light', 'dark', 'system'];
const MEDIA_QUERY = '(prefers-color-scheme: dark)';

const ThemeContext = createContext(null);

/** Defensive read: unknown / corrupt / absent stored value → 'system'. */
export function readStoredSetting() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return VALID_SETTINGS.includes(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

/** True if the OS currently prefers a dark appearance. */
export function osPrefersDark() {
  try {
    return !!(window.matchMedia && window.matchMedia(MEDIA_QUERY).matches);
  } catch {
    return false;
  }
}

/** Pure resolution: (setting, osPrefersDark) → 'light' | 'dark'. */
export function resolve(setting, prefersDark) {
  if (setting === 'light') return 'light';
  if (setting === 'dark') return 'dark';
  // 'system' or anything unrecognized follows the OS.
  return prefersDark ? 'dark' : 'light';
}

/** Stamp the resolved theme on the document root (idempotent). */
function applyResolvedTheme(resolved) {
  try {
    if (document.documentElement.getAttribute('data-theme') !== resolved) {
      document.documentElement.setAttribute('data-theme', resolved);
    }
  } catch {
    /* no-op: nothing to apply outside a DOM (e.g. SSR) */
  }
}

export function ThemeProvider({ children }) {
  const [setting, setSettingState] = useState(readStoredSetting);
  const [resolvedTheme, setResolvedTheme] = useState(() =>
    resolve(setting, osPrefersDark())
  );

  // Reconcile the attribute from storage on mount. The bootstrap already set it;
  // this only writes if it somehow diverges, so it never causes a visible flash.
  useEffect(() => {
    const resolved = resolve(setting, osPrefersDark());
    setResolvedTheme(resolved);
    applyResolvedTheme(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setting]);

  // Follow the OS live — ONLY while the setting is 'system' (FR-003, US2).
  useEffect(() => {
    if (setting !== 'system') return undefined;
    let mql;
    try {
      mql = window.matchMedia(MEDIA_QUERY);
    } catch {
      return undefined;
    }
    const onChange = () => {
      const resolved = resolve('system', osPrefersDark());
      setResolvedTheme(resolved);
      applyResolvedTheme(resolved);
    };
    // addEventListener is standard; addListener is the legacy Safari fallback.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else if (mql.addListener) mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else if (mql.removeListener) mql.removeListener(onChange);
    };
  }, [setting]);

  // The only writer of the preference. Persists on explicit choice, updates
  // state + attribute; OS-follow (re)subscription is handled by the effect above.
  const setSetting = useCallback((next) => {
    const value = VALID_SETTINGS.includes(next) ? next : 'system';
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* persistence is best-effort; the in-memory setting still applies */
    }
    const resolved = resolve(value, osPrefersDark());
    setSettingState(value);
    setResolvedTheme(resolved);
    applyResolvedTheme(resolved);
  }, []);

  const value = { setting, resolvedTheme, setSetting };
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}

export default ThemeContext;
