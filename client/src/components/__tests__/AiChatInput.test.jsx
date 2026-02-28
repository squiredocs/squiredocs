import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AiChatInput from '../AiChatInput';

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

    expect(onSend).toHaveBeenCalledWith('Hello world');
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

    expect(onSend).toHaveBeenCalledWith('Hello');
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
});
