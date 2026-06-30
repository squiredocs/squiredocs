import { useState, useCallback, useRef } from 'react';

const STORAGE_KEY = 'chatPrefs';

const MIN = 0.8;
const MAX = 1.8;
const STEP = 0.1;
const DEFAULT = 1;

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {};
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

// Round to one decimal place so repeated +/- STEP doesn't accumulate float drift.
const clamp = (v) => {
  const rounded = Math.round(v * 10) / 10;
  return Math.max(MIN, Math.min(MAX, rounded));
};

/**
 * Device-local chat font-size preference (a multiplier applied to chat message
 * text via the --chat-font-scale CSS var). Persisted to localStorage under
 * `chatPrefs`, mirroring useAiPanel.js.
 */
export function useChatFontScale() {
  const prefs = useRef(loadPrefs());

  const [fontScale, setFontScale] = useState(() => {
    const stored = prefs.current.fontScale;
    return typeof stored === 'number' ? clamp(stored) : DEFAULT;
  });

  const apply = useCallback((next) => {
    const value = clamp(next);
    setFontScale(value);
    prefs.current = { ...prefs.current, fontScale: value };
    savePrefs(prefs.current);
  }, []);

  const increase = useCallback(() => apply(fontScale + STEP), [apply, fontScale]);
  const decrease = useCallback(() => apply(fontScale - STEP), [apply, fontScale]);

  return {
    fontScale,
    increase,
    decrease,
    canIncrease: fontScale < MAX,
    canDecrease: fontScale > MIN,
  };
}
