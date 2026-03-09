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

    expect(screen.getByRole('button', { name: 'Attach image' })).toBeInTheDocument();
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

  // --------------- Image attachment ---------------

  it('shows preview strip after adding files via addFiles ref', async () => {
    const ref = createRef();
    render(<AiChatInput ref={ref} onSend={onSend} onStop={onStop} isStreaming={false} />);

    const file = createMockFile('test.png', 1024, 'image/png');
    ref.current.addFiles([file]);

    await waitFor(() => {
      expect(screen.getByAltText('test.png')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Remove image' })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    expect(screen.queryByAltText('test.png')).not.toBeInTheDocument();
    // Send should be disabled again
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('rejects non-image files with error message', async () => {
    const ref = createRef();
    const { container } = render(<AiChatInput ref={ref} onSend={onSend} onStop={onStop} isStreaming={false} />);

    const file = createMockFile('doc.pdf', 1024, 'application/pdf');
    ref.current.addFiles([file]);

    await waitFor(() => {
      expect(container.querySelector('.ai-chat-file-error')).toHaveTextContent('Only images (PNG, JPEG, GIF, WebP) are supported.');
    });
  });

  it('rejects files over 4MB with error message', async () => {
    const ref = createRef();
    const { container } = render(<AiChatInput ref={ref} onSend={onSend} onStop={onStop} isStreaming={false} />);

    const file = createMockFile('big.png', 5 * 1024 * 1024, 'image/png');
    ref.current.addFiles([file]);

    await waitFor(() => {
      expect(container.querySelector('.ai-chat-file-error')).toHaveTextContent('Images must be under 4MB each.');
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
});
