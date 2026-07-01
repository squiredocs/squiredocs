import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Hoisted so the vi.mock factory can reference it.
const { addSelectionRefSpy } = vi.hoisted(() => ({ addSelectionRefSpy: vi.fn() }));
vi.mock('../../contexts/AiChatContext', () => ({
  useAiChat: () => ({ addSelectionRef: addSelectionRefSpy }),
}));

import SelectionChatButton from '../SelectionChatButton';

// Minimal fake TipTap editor exercising just the surface the button reads.
function makeEditor({ empty = false, text = 'hello world', heading = 'Section A' } = {}) {
  const tr = {};
  tr.setMeta = vi.fn(() => tr); // chainable, returns the transaction
  return {
    state: {
      selection: { empty, from: 1, to: 5 },
      tr,
      doc: {
        content: { size: 100 },
        textBetween: () => (empty ? '' : text),
        nodesBetween: (_from, _to, cb) => {
          if (heading) cb({ type: { name: 'heading' }, textContent: heading });
        },
      },
    },
    view: { coordsAtPos: () => ({ left: 10, bottom: 20, top: 10, right: 30 }), dispatch: vi.fn() },
    commands: { setTextSelection: vi.fn() },
  };
}

describe('SelectionChatButton', () => {
  beforeEach(() => {
    addSelectionRefSpy.mockClear();
  });

  it('renders nothing when the selection is empty', () => {
    render(<SelectionChatButton editor={makeEditor({ empty: true })} docId="doc-1" />);
    expect(screen.queryByRole('button', { name: 'Add selection to chat' })).not.toBeInTheDocument();
  });

  it('shows the tag for a non-empty text selection', () => {
    render(<SelectionChatButton editor={makeEditor()} docId="doc-1" />);
    expect(screen.getByRole('button', { name: 'Add selection to chat' })).toBeInTheDocument();
  });

  it('docks the button above the keyboard on mobile instead of anchoring to the selection', () => {
    // On touch devices the selection-anchored tag collides with the native
    // iOS callout, so we dock it to the visible viewport bottom instead.
    const editor = makeEditor();
    render(<SelectionChatButton editor={editor} docId="doc-1" isMobile />);

    const btn = screen.getByRole('button', { name: 'Add selection to chat' });
    expect(btn.className).toContain('selection-chat-btn--docked');
    expect(btn.style.bottom).toBeTruthy();
    expect(btn.style.top).toBe('');
  });

  it('captures the passage + heading + source document and opens the panel on click', async () => {
    const user = userEvent.setup();
    const editor = makeEditor({ text: 'the auth service' });
    const onRequestOpenChat = vi.fn();
    render(<SelectionChatButton editor={editor} docId="doc-7" docTitle="Launch Plan" onRequestOpenChat={onRequestOpenChat} />);

    await user.click(screen.getByRole('button', { name: 'Add selection to chat' }));

    expect(addSelectionRefSpy).toHaveBeenCalledWith({
      text: 'the auth service',
      heading: 'Section A',
      docId: 'doc-7',
      docTitle: 'Launch Plan',
    });
    // Paints a persistent highlight over the passage so it stays visible after
    // the selection is collapsed and the editor blurs into the chat.
    expect(editor.state.tr.setMeta).toHaveBeenCalledWith(
      expect.anything(),
      { type: 'paint', from: 1, to: 5 },
    );
    expect(editor.view.dispatch).toHaveBeenCalled();
    // Collapses the selection to dismiss the tag and signal capture.
    expect(editor.commands.setTextSelection).toHaveBeenCalledWith(5);
    expect(onRequestOpenChat).toHaveBeenCalled();
  });

  it('records a null heading when the selection has no enclosing heading', async () => {
    const user = userEvent.setup();
    render(<SelectionChatButton editor={makeEditor({ heading: null })} docId="doc-2" />);

    await user.click(screen.getByRole('button', { name: 'Add selection to chat' }));

    expect(addSelectionRefSpy).toHaveBeenCalledWith(expect.objectContaining({ heading: null }));
  });
});
