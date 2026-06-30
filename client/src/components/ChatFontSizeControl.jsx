import React from 'react';
import './ChatFontSizeControl.css';

/**
 * Stepper for adjusting only the chat message text size. State + persistence
 * live in useChatFontScale; this is the presentational control rendered in the
 * chat header (side panel) and full-page chat toolbar.
 */
export default function ChatFontSizeControl({ onIncrease, onDecrease, canIncrease, canDecrease }) {
  return (
    <div className="chat-font-size-control">
      <button
        className="icon-btn chat-font-size-btn"
        onClick={onDecrease}
        disabled={!canDecrease}
        aria-label="Decrease chat text size"
        title="Decrease chat text size"
      >
        <span className="chat-font-size-glyph chat-font-size-glyph--small">A</span>
      </button>
      <button
        className="icon-btn chat-font-size-btn"
        onClick={onIncrease}
        disabled={!canIncrease}
        aria-label="Increase chat text size"
        title="Increase chat text size"
      >
        <span className="chat-font-size-glyph chat-font-size-glyph--large">A</span>
      </button>
    </div>
  );
}
