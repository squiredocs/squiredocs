import React from 'react';

/**
 * Swap-arrows icon button that toggles between chat-centric and document-centric views.
 * Renders nothing if onClick is falsy.
 */
export default function ViewToggleButton({ onClick }) {
  if (!onClick) return null;
  return (
    <button className="icon-btn" onClick={onClick} title="Switch view" aria-label="Switch view">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="17 1 21 5 17 9" />
        <path d="M3 11V9a4 4 0 014-4h14" />
        <polyline points="7 23 3 19 7 15" />
        <path d="M21 13v2a4 4 0 01-4 4H3" />
      </svg>
    </button>
  );
}
