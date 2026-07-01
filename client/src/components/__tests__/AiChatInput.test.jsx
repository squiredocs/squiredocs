import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AiChatInput from '../AiChatInput';

// Helper: create a mock File object
function createMockFile(name, size, type) {
  const content = new Uint8Array(size);
  return new File([content], name, { type });
}

describe('AiChatInput', () => {
  let onSend;
  let onStop;

  beforeEach(() => {
    onSend = vi.fn();
    onStop = vi.fn();
  });

  it('renders textarea and send button', () => {
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} />);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
  });

  it('renders attach button', () => {
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} />);

    expect(screen.getByRole('button', { name: 'Attach file' })).toBeInTheDocument();
  });

  it('send button is disabled when input is empty', () => {
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} />);

    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('calls onSend with trimmed text on button click', async () => {
    const user = userEvent.setup();
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, '  Hello world  ');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(onSend).toHaveBeenCalledWith('Hello world', undefined);
  });

  it('clears input after sending', async () => {
    const user = userEvent.setup();
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(textarea).toHaveValue('');
  });

  it('sends on Enter key', async () => {
    const user = userEvent.setup();
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello{Enter}');

    expect(onSend).toHaveBeenCalledWith('Hello', undefined);
  });

  it('does not send on Shift+Enter', async () => {
    const user = userEvent.setup();
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello{Shift>}{Enter}{/Shift}');

    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send when streaming even via Enter', async () => {
    const user = userEvent.setup();
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={true} />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello{Enter}');

    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows stop button when streaming', () => {
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={true} />);

    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
  });

  it('calls onStop when stop button is clicked', async () => {
    const user = userEvent.setup();
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={true} />);

    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(onStop).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows send button when not streaming', () => {
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} />);

    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  // --------------- Draft text restoration ---------------

  it('restores draft text when draftText prop is set', () => {
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} draftText="restored message" onDraftConsumed={vi.fn()} />);

    expect(screen.getByRole('textbox')).toHaveValue('restored message');
  });

  it('calls onDraftConsumed after restoring draft', () => {
    const onDraftConsumed = vi.fn();
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} draftText="restored" onDraftConsumed={onDraftConsumed} />);

    expect(onDraftConsumed).toHaveBeenCalled();
  });

  it('does not restore when draftText is empty', () => {
    const onDraftConsumed = vi.fn();
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} draftText="" onDraftConsumed={onDraftConsumed} />);

    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(onDraftConsumed).not.toHaveBeenCalled();
  });

  // --------------- Per-chat draft persistence ---------------

  it('seeds the textarea from the persisted draft for the current chat', () => {
    const getChatDraft = vi.fn((id) => (id === 'chat-1' ? { text: 'unsent words', files: null } : null));
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} chatId="chat-1" getChatDraft={getChatDraft} saveChatDraft={vi.fn()} />);

    expect(getChatDraft).toHaveBeenCalledWith('chat-1');
    expect(screen.getByRole('textbox')).toHaveValue('unsent words');
  });

  it('persists typed input to the per-chat draft store as the user types', async () => {
    const user = userEvent.setup();
    const saveChatDraft = vi.fn();
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} chatId="chat-7" getChatDraft={vi.fn(() => null)} saveChatDraft={saveChatDraft} />);

    await user.type(screen.getByRole('textbox'), 'Hi');

    expect(saveChatDraft).toHaveBeenLastCalledWith('chat-7', 'Hi', []);
  });

  it('clears the persisted draft after sending', async () => {
    const user = userEvent.setup();
    const saveChatDraft = vi.fn();
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} chatId="chat-9" getChatDraft={vi.fn(() => null)} saveChatDraft={saveChatDraft} />);

    await user.type(screen.getByRole('textbox'), 'Send me');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    // The send empties the input, which writes an empty draft (the store then forgets it).
    expect(saveChatDraft).toHaveBeenLastCalledWith('chat-9', '', []);
  });

  it('works without draft-store props (backward compatible)', async () => {
    const user = userEvent.setup();
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} />);

    await user.type(screen.getByRole('textbox'), 'Hello{Enter}');
    expect(onSend).toHaveBeenCalledWith('Hello', undefined);
  });

  // --------------- Image attachment ---------------

  it('shows preview strip after adding files via addFiles ref', async () => {
    const ref = createRef();
    render(<AiChatInput ref={ref} onSend={onSend} onStop={onStop} isStreaming={false} />);

    const file = createMockFile('test.png', 1024, 'image/png');
    ref.current.addFiles([file]);

    await waitFor(() => {
      expect(screen.getByAltText('test.png')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Remove file' })).toBeInTheDocument();
  });

  it('enables send button when files are attached even with empty text', async () => {
    const ref = createRef();
    render(<AiChatInput ref={ref} onSend={onSend} onStop={onStop} isStreaming={false} />);

    const file = createMockFile('test.png', 1024, 'image/png');
    ref.current.addFiles([file]);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled();
    });
  });

  it('sends files with onSend and clears preview after send', async () => {
    const ref = createRef();
    render(<AiChatInput ref={ref} onSend={onSend} onStop={onStop} isStreaming={false} />);

    const file = createMockFile('test.png', 1024, 'image/png');
    ref.current.addFiles([file]);

    await waitFor(() => {
      expect(screen.getByAltText('test.png')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(onSend).toHaveBeenCalledWith('', expect.arrayContaining([
      expect.objectContaining({ type: 'file', mediaType: 'image/png', filename: 'test.png' }),
    ]));
    // Preview should be cleared
    expect(screen.queryByAltText('test.png')).not.toBeInTheDocument();
  });

  it('removes file from preview when remove button is clicked', async () => {
    const ref = createRef();
    render(<AiChatInput ref={ref} onSend={onSend} onStop={onStop} isStreaming={false} />);

    const file = createMockFile('test.png', 1024, 'image/png');
    ref.current.addFiles([file]);

    await waitFor(() => {
      expect(screen.getByAltText('test.png')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove file' }));
    expect(screen.queryByAltText('test.png')).not.toBeInTheDocument();
    // Send should be disabled again
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('rejects unsupported file types with error message', async () => {
    const ref = createRef();
    const { container } = render(<AiChatInput ref={ref} onSend={onSend} onStop={onStop} isStreaming={false} />);

    const file = createMockFile('archive.zip', 1024, 'application/zip');
    ref.current.addFiles([file]);

    await waitFor(() => {
      expect(container.querySelector('.ai-chat-file-error')).toHaveTextContent('Unsupported file type. Supported: images, PDF, TXT, CSV.');
    });
  });

  it('accepts PDF files and shows file preview', async () => {
    const ref = createRef();
    const { container } = render(<AiChatInput ref={ref} onSend={onSend} onStop={onStop} isStreaming={false} />);

    const file = createMockFile('report.pdf', 1024, 'application/pdf');
    ref.current.addFiles([file]);

    await waitFor(() => {
      expect(container.querySelector('.ai-chat-preview-file')).toBeInTheDocument();
    });
    expect(container.querySelector('.ai-chat-preview-filename')).toHaveTextContent('report.pdf');
  });

  it('rejects files over 15MB with error message', async () => {
    const ref = createRef();
    const { container } = render(<AiChatInput ref={ref} onSend={onSend} onStop={onStop} isStreaming={false} />);

    const file = createMockFile('big.png', 16 * 1024 * 1024, 'image/png');
    ref.current.addFiles([file]);

    await waitFor(() => {
      expect(container.querySelector('.ai-chat-file-error')).toHaveTextContent('Files must be under 15MB each.');
    });
  });

  it('restores draft files when draftFiles prop is set', () => {
    const draftFiles = [
      { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc', filename: 'draft.png' },
    ];
    const onDraftFilesConsumed = vi.fn();
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} draftFiles={draftFiles} onDraftFilesConsumed={onDraftFilesConsumed} />);

    expect(screen.getByAltText('draft.png')).toBeInTheDocument();
    expect(onDraftFilesConsumed).toHaveBeenCalled();
  });

  it('sends text and files together', async () => {
    const ref = createRef();
    const user = userEvent.setup();
    render(<AiChatInput ref={ref} onSend={onSend} onStop={onStop} isStreaming={false} />);

    const file = createMockFile('photo.jpg', 1024, 'image/jpeg');
    ref.current.addFiles([file]);

    await waitFor(() => {
      expect(screen.getByAltText('photo.jpg')).toBeInTheDocument();
    });

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Check this out{Enter}');

    expect(onSend).toHaveBeenCalledWith('Check this out', expect.arrayContaining([
      expect.objectContaining({ type: 'file', mediaType: 'image/jpeg' }),
    ]));
  });

  it('handles paste with image files', () => {
    const { container } = render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} />);
    const textarea = screen.getByRole('textbox');

    const file = createMockFile('screenshot.png', 1024, 'image/png');
    const clipboardData = {
      files: [file],
    };
    const pasteEvent = new Event('paste', { bubbles: true });
    Object.defineProperty(pasteEvent, 'clipboardData', { value: clipboardData });
    pasteEvent.preventDefault = vi.fn();

    textarea.dispatchEvent(pasteEvent);

    expect(pasteEvent.preventDefault).toHaveBeenCalled();
  });

  it('does not intercept paste without image files', () => {
    render(<AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} />);
    const textarea = screen.getByRole('textbox');

    const clipboardData = {
      files: [],
    };
    const pasteEvent = new Event('paste', { bubbles: true });
    Object.defineProperty(pasteEvent, 'clipboardData', { value: clipboardData });
    pasteEvent.preventDefault = vi.fn();

    textarea.dispatchEvent(pasteEvent);

    expect(pasteEvent.preventDefault).not.toHaveBeenCalled();
  });

  // --------------- "Add to Chat" selection references ---------------

  const sampleRefs = [
    { id: 'sel-1', text: 'the auth service shipping', heading: 'Objectives', docTitle: 'Launch Plan' },
    { id: 'sel-2', text: 'a second passage', heading: null, docTitle: 'Design Notes' },
  ];

  it('renders a chip per pending selection reference', () => {
    const { container } = render(
      <AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} pendingRefs={sampleRefs} onRemoveRef={vi.fn()} />
    );

    expect(container.querySelectorAll('.ai-chat-ref-chip')).toHaveLength(2);
    expect(screen.getByText(/the auth service shipping/)).toBeInTheDocument();
    expect(screen.getByText('Objectives:')).toBeInTheDocument();
  });

  it('shows the source document name on each reference chip', () => {
    render(
      <AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} pendingRefs={sampleRefs} onRemoveRef={vi.fn()} />
    );

    expect(screen.getByText('Launch Plan')).toBeInTheDocument();
    expect(screen.getByText('Design Notes')).toBeInTheDocument();
  });

  it('calls onRemoveRef with the ref id when its remove button is clicked', async () => {
    const user = userEvent.setup();
    const onRemoveRef = vi.fn();
    render(
      <AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} pendingRefs={sampleRefs} onRemoveRef={onRemoveRef} />
    );

    const removeButtons = screen.getAllByRole('button', { name: 'Remove reference' });
    await user.click(removeButtons[0]);

    expect(onRemoveRef).toHaveBeenCalledWith('sel-1');
  });

  it('enables send when refs are present even with empty text', () => {
    render(
      <AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} pendingRefs={sampleRefs} onRemoveRef={vi.fn()} />
    );

    expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled();
  });

  it('sends with empty text when only refs are attached', async () => {
    const user = userEvent.setup();
    render(
      <AiChatInput onSend={onSend} onStop={onStop} isStreaming={false} pendingRefs={sampleRefs} onRemoveRef={vi.fn()} />
    );

    await user.click(screen.getByRole('button', { name: 'Send message' }));

    // The refs themselves are folded in by the context's sendMessage, so the
    // input just emits the (empty) typed text.
    expect(onSend).toHaveBeenCalledWith('', undefined);
  });
});
