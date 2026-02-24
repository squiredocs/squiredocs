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
 * isOpen is NOT persisted — starts false every page load.
 * position, widthPx, heightPx are persisted to localStorage.
 */
export function useAiPanel() {
  const prefs = useRef(loadPrefs());

  const [isOpen, setIsOpen] = useState(false);
  const [isPoppedOut, setIsPoppedOut] = useState(false);
  const [position, setPositionState] = useState(prefs.current.position || 'right');
  const [widthPx, setWidthPx] = useState(prefs.current.widthPx || 380);
  const [heightPx, setHeightPx] = useState(prefs.current.heightPx || 300);
  const popupWindowRef = useRef(null);

  const toggle = useCallback(() => setIsOpen(prev => !prev), []);

  const close = useCallback(() => {
    setIsOpen(false);
    setIsPoppedOut(false);
  }, []);

  const popOut = useCallback(() => {
    setIsOpen(true);
    setIsPoppedOut(true);
  }, []);

  const popIn = useCallback(() => {
    setIsPoppedOut(false);
  }, []);

  const setPopupWindow = useCallback((win) => {
    popupWindowRef.current = win;
  }, []);

  const focusPopup = useCallback(() => {
    if (popupWindowRef.current && !popupWindowRef.current.closed) {
      popupWindowRef.current.focus();
    }
  }, []);

  const persistPref = useCallback((key, value) => {
    prefs.current = { ...prefs.current, [key]: value };
    savePrefs(prefs.current);
  }, []);

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
    isPoppedOut,
    popOut,
    popIn,
    setPopupWindow,
    focusPopup,
    position,
    setPosition,
    widthPx,
    updateWidth,
    heightPx,
    updateHeight,
  };
}
