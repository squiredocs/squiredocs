import { useReducer, useEffect, useCallback } from 'react';
import { useAiChat } from '../contexts/AiChatContext';
import './SelectionChatButton.css';

// Cap a captured passage so a huge selection doesn't bloat the message. The
// quote only needs to be enough for the assistant to recognize/locate the
// passage, not reproduce the whole document.
const MAX_REF_CHARS = 2000;

function capLength(text) {
  if (text.length <= MAX_REF_CHARS) return text;
  return text.slice(0, MAX_REF_CHARS).trimEnd() + '…';
}

// The nearest heading at or before `pos` — a cheap structural hint that helps
// the assistant disambiguate a quote that might appear more than once.
function findEnclosingHeading(state, pos) {
  let headingText = null;
  try {
    state.doc.nodesBetween(0, Math.min(pos, state.doc.content.size), (node) => {
      if (node.type.name === 'heading') headingText = node.textContent || null;
    });
  } catch {
    // Position math can throw mid-edit; the hint is optional, so swallow it.
  }
  return headingText;
}

/**
 * Floating "Add to Chat" tag shown off a non-empty text selection in the editor.
 * Clicking it captures the selected passage (plus the enclosing heading) as a
 * pending chat reference and opens the AI panel, so the user can ask about that
 * part of the document without describing it.
 *
 * The useAiChat() subscription is isolated here (not in Editor) so streaming
 * chat tokens don't re-render the editor — this tiny component absorbs them.
 */
export default function SelectionChatButton({ editor, docId, docTitle, isMobile, onRequestOpenChat }) {
  const { addSelectionRef } = useAiChat() || {};
  // Selection coords come from the live editor state (Editor re-renders on every
  // transaction via shouldRerenderOnTransaction). Scrolling doesn't fire a
  // transaction, so bump a tick on scroll/resize to keep the tag glued to the
  // selection.
  const [, bump] = useReducer((x) => x + 1, 0);

  const sel = editor?.state?.selection;
  const hasText = !!sel && !sel.empty &&
    editor.state.doc.textBetween(sel.from, sel.to, ' ').trim().length > 0;

  useEffect(() => {
    if (!hasText) return undefined;
    // Capture phase catches scrolling of the inner editor container too.
    window.addEventListener('scroll', bump, true);
    window.addEventListener('resize', bump);
    // The mobile button rides above the on-screen keyboard; the layout viewport
    // doesn't change when the keyboard opens, so track the visual viewport too.
    const vv = window.visualViewport;
    vv?.addEventListener('resize', bump);
    vv?.addEventListener('scroll', bump);
    return () => {
      window.removeEventListener('scroll', bump, true);
      window.removeEventListener('resize', bump);
      vv?.removeEventListener('resize', bump);
      vv?.removeEventListener('scroll', bump);
    };
  }, [hasText]);

  const handleAdd = useCallback(() => {
    if (!editor || !addSelectionRef) return;
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, '\n').trim();
    if (!text) return;
    addSelectionRef({
      text: capLength(text),
      heading: findEnclosingHeading(editor.state, from),
      docId: docId || null,
      docTitle: docTitle || null,
    });
    // Collapse the selection so the tag dismisses and the user gets a clear
    // "captured" cue; the panel then opens to show the new chip.
    editor.commands.setTextSelection(to);
    onRequestOpenChat?.();
  }, [editor, addSelectionRef, docId, docTitle, onRequestOpenChat]);

  if (!hasText || !addSelectionRef) return null;

  const icon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
  // Keep the editor selection intact through the click (both platforms fire
  // mousedown before the click, and preventing it stops focus/selection loss).
  const commonProps = {
    type: 'button',
    onMouseDown: (e) => e.preventDefault(),
    onClick: handleAdd,
    'aria-label': 'Add selection to chat',
    title: 'Add selection to chat',
  };

  // On touch devices, iOS/Android render their own selection callout
  // (Cut/Copy/Paste/AutoFill) hugging the selection, repositioning it above or
  // below with no stable gap — a selection-anchored tag ends up buried behind
  // it. Dock the button to the bottom of the *visible* viewport instead: above
  // the on-screen keyboard and clear of the callout, which sits up by the text.
  if (isMobile) {
    const vv = window.visualViewport;
    const keyboardInset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    return (
      <button
        {...commonProps}
        className="selection-chat-btn selection-chat-btn--docked"
        style={{ bottom: `${keyboardInset + 12}px` }}
      >
        {icon}
        <span>Add selection to Chat</span>
      </button>
    );
  }

  // Desktop: anchor the tag just below the selection end.
  let coords;
  try {
    coords = editor.view.coordsAtPos(editor.state.selection.to);
  } catch {
    return null;
  }
  const GAP = 6;
  const estWidth = 116;
  const left = Math.max(8, Math.min(coords.left, window.innerWidth - estWidth - 8));
  const top = coords.bottom + GAP;

  return (
    <button
      {...commonProps}
      className="selection-chat-btn"
      style={{ top: `${top}px`, left: `${left}px` }}
    >
      {icon}
      <span>Add to Chat</span>
    </button>
  );
}
