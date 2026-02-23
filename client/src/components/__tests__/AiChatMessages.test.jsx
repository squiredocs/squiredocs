import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import AiChatMessages from '../AiChatMessages';

const makeMsg = (overrides) => ({
  id: `msg-${Math.random()}`,
  role: 'user',
  content: 'Hello',
  status: 'complete',
  timestamp: Date.now(),
  ...overrides,
});

describe('AiChatMessages', () => {
  it('renders nothing inside the list when messages is empty', () => {
    const { container } = render(<AiChatMessages messages={[]} />);

    const messageList = container.querySelector('.ai-chat-messages');
    expect(messageList).toBeInTheDocument();
    expect(messageList.children).toHaveLength(0);
  });

  it('renders user message with correct class', () => {
    const messages = [makeMsg({ content: 'User text', role: 'user' })];
    const { container } = render(<AiChatMessages messages={messages} />);

    const bubble = container.querySelector('.ai-chat-bubble--user');
    expect(bubble).toBeInTheDocument();
    expect(bubble.textContent).toBe('User text');
  });

  it('renders assistant message with correct class', () => {
    const messages = [makeMsg({ content: 'Bot reply', role: 'assistant' })];
    const { container } = render(<AiChatMessages messages={messages} />);

    const bubble = container.querySelector('.ai-chat-bubble--assistant');
    expect(bubble).toBeInTheDocument();
    expect(bubble.textContent).toBe('Bot reply');
  });

  it('renders multiple messages in order', () => {
    const messages = [
      makeMsg({ id: '1', role: 'user', content: 'First' }),
      makeMsg({ id: '2', role: 'assistant', content: 'Second' }),
      makeMsg({ id: '3', role: 'user', content: 'Third' }),
    ];
    const { container } = render(<AiChatMessages messages={messages} />);

    const bubbles = container.querySelectorAll('.ai-chat-bubble');
    expect(bubbles).toHaveLength(3);
    expect(bubbles[0].textContent).toBe('First');
    expect(bubbles[1].textContent).toBe('Second');
    expect(bubbles[2].textContent).toBe('Third');
  });

  it('shows typing indicator for streaming messages', () => {
    const messages = [
      makeMsg({ role: 'assistant', content: 'Partial...', status: 'streaming' }),
    ];
    const { container } = render(<AiChatMessages messages={messages} />);

    expect(container.querySelector('.ai-typing-indicator')).toBeInTheDocument();
    expect(container.querySelectorAll('.ai-typing-dot')).toHaveLength(3);
  });

  it('shows typing indicator for streaming messages with empty content', () => {
    const messages = [
      makeMsg({ role: 'assistant', content: '', status: 'streaming' }),
    ];
    const { container } = render(<AiChatMessages messages={messages} />);

    expect(container.querySelector('.ai-typing-indicator')).toBeInTheDocument();
  });

  it('does not show typing indicator for complete messages', () => {
    const messages = [
      makeMsg({ role: 'assistant', content: 'Done', status: 'complete' }),
    ];
    const { container } = render(<AiChatMessages messages={messages} />);

    expect(container.querySelector('.ai-typing-indicator')).not.toBeInTheDocument();
  });

  it('auto-scrolls to bottom when messages change', () => {
    const messages = [makeMsg({ id: '1', content: 'Hello' })];
    const { container, rerender } = render(<AiChatMessages messages={messages} />);

    const scrollEl = container.querySelector('.ai-chat-messages');
    // Mock scrollHeight to simulate content taller than container
    Object.defineProperty(scrollEl, 'scrollHeight', { value: 500, configurable: true });

    const updated = [...messages, makeMsg({ id: '2', content: 'World' })];
    rerender(<AiChatMessages messages={updated} />);

    expect(scrollEl.scrollTop).toBe(500);
  });
});
