import { useState, useCallback, useRef } from 'react';

const STORAGE_KEY = 'aiPanelPrefs';

const CANNED_RESPONSES = [
  "I can help you with your document. What would you like to know?",
  "That's an interesting question. Let me think about that...",
  "I'd suggest reviewing the structure of your document for better flow.",
  "Great question! Here are a few things to consider about your document.",
  "I can help you refine that section. Would you like me to suggest some edits?",
];

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

function makeId() {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Single source of truth for all AI panel state.
 * isOpen is NOT persisted — starts false every page load.
 * position, widthPx, heightPx are persisted to localStorage.
 */
export function useAiPanel() {
  const prefs = useRef(loadPrefs());

  const [isOpen, setIsOpen] = useState(false);
  const [position, setPositionState] = useState(prefs.current.position || 'right');
  const [widthPx, setWidthPx] = useState(prefs.current.widthPx || 380);
  const [heightPx, setHeightPx] = useState(prefs.current.heightPx || 300);
  const [messages, setMessages] = useState([]);

  const toggle = useCallback(() => setIsOpen(prev => !prev), []);

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

  const sendMessage = useCallback((text) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const userMsg = {
      id: makeId(),
      role: 'user',
      content: trimmed,
      status: 'complete',
      timestamp: Date.now(),
    };

    const assistantId = makeId();
    const assistantMsg = {
      id: assistantId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);

    // Simulate streaming response
    const response = CANNED_RESPONSES[Math.floor(Math.random() * CANNED_RESPONSES.length)];
    let charIndex = 0;

    const interval = setInterval(() => {
      charIndex += 3;
      const partial = response.slice(0, charIndex);
      const done = charIndex >= response.length;

      setMessages(prev =>
        prev.map(m =>
          m.id === assistantId
            ? { ...m, content: done ? response : partial, status: done ? 'complete' : 'streaming' }
            : m
        )
      );

      if (done) clearInterval(interval);
    }, 30);
  }, []);

  return {
    isOpen,
    setIsOpen,
    toggle,
    position,
    setPosition,
    widthPx,
    updateWidth,
    heightPx,
    updateHeight,
    messages,
    sendMessage,
  };
}
