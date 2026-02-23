import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AiChatInput from '../AiChatInput';

describe('AiChatInput', () => {
  let onSend;

  beforeEach(() => {
    onSend = vi.fn();
  });

  it('renders textarea and send button', () => {
    render(<AiChatInput onSend={onSend} disabled={false} />);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
  });

  it('send button is disabled when input is empty', () => {
    render(<AiChatInput onSend={onSend} disabled={false} />);

    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('send button is disabled when disabled prop is true', async () => {
    const user = userEvent.setup();
    render(<AiChatInput onSend={onSend} disabled={true} />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello');

    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('calls onSend with trimmed text on button click', async () => {
    const user = userEvent.setup();
    render(<AiChatInput onSend={onSend} disabled={false} />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, '  Hello world  ');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(onSend).toHaveBeenCalledWith('Hello world');
  });

  it('clears input after sending', async () => {
    const user = userEvent.setup();
    render(<AiChatInput onSend={onSend} disabled={false} />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(textarea).toHaveValue('');
  });

  it('sends on Enter key', async () => {
    const user = userEvent.setup();
    render(<AiChatInput onSend={onSend} disabled={false} />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello{Enter}');

    expect(onSend).toHaveBeenCalledWith('Hello');
  });

  it('does not send on Shift+Enter', async () => {
    const user = userEvent.setup();
    render(<AiChatInput onSend={onSend} disabled={false} />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello{Shift>}{Enter}{/Shift}');

    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send when disabled even via Enter', async () => {
    const user = userEvent.setup();
    render(<AiChatInput onSend={onSend} disabled={true} />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello{Enter}');

    expect(onSend).not.toHaveBeenCalled();
  });
});
