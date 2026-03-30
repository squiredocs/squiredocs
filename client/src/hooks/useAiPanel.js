import { useState, useCallback, useRef } from 'react';

const STORAGE_KEY = 'aiPanelPrefs';

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

/**
 * Single source of truth for all AI panel state.
 * isOpen, position, widthPx, heightPx are persisted to localStorage.
 */
export function useAiPanel() {
  const prefs = useRef(loadPrefs());

  const [isOpen, setIsOpen] = useState(prefs.current.isOpen || false);
  const [position, setPositionState] = useState(prefs.current.position || 'right');
  const [widthPx, setWidthPx] = useState(prefs.current.widthPx || 380);
  const [heightPx, setHeightPx] = useState(prefs.current.heightPx || 300);

  const persistPref = useCallback((key, value) => {
    prefs.current = { ...prefs.current, [key]: value };
    savePrefs(prefs.current);
  }, []);

  const toggle = useCallback(() => setIsOpen(prev => {
    const next = !prev;
    persistPref('isOpen', next);
    return next;
  }), [persistPref]);

  const close = useCallback(() => {
    setIsOpen(false);
    persistPref('isOpen', false);
  }, [persistPref]);

  const setPosition = useCallback((pos) => {
    setPositionState(pos);
    persistPref('position', pos);
  }, [persistPref]);

  const updateWidth = useCallback((px) => {
    setWidthPx(px);
    persistPref('widthPx', px);
  }, [persistPref]);

  const updateHeight = useCallback((px) => {
    setHeightPx(px);
    persistPref('heightPx', px);
  }, [persistPref]);

  return {
    isOpen,
    setIsOpen,
    toggle,
    close,
    position,
    setPosition,
    widthPx,
    updateWidth,
    heightPx,
    updateHeight,
  };
}
