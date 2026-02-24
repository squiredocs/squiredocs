import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import AiChatMessages from '../AiChatMessages';

const makeMsg = (overrides) => ({
  id: `msg-${Math.random()}`,
  role: 'user',
  content: 'Hello',
  parts: [{ type: 'text', text: 'Hello' }],
  ...overrides,
});

describe('AiChatMessages', () => {
  it('renders nothing inside the list when messages is empty', () => {
    const { container } = render(<AiChatMessages messages={[]} status="ready" />);

    const messageList = container.querySelector('.ai-chat-messages');
    expect(messageList).toBeInTheDocument();
    expect(messageList.children).toHaveLength(0);
  });

  it('renders user message with correct class', () => {
    const messages = [makeMsg({ role: 'user', parts: [{ type: 'text', text: 'User text' }] })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const bubble = container.querySelector('.ai-chat-bubble--user');
    expect(bubble).toBeInTheDocument();
    expect(bubble.textContent).toBe('User text');
  });

  it('renders assistant message with correct class', () => {
    const messages = [makeMsg({ role: 'assistant', parts: [{ type: 'text', text: 'Bot reply' }] })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const bubble = container.querySelector('.ai-chat-bubble--assistant');
    expect(bubble).toBeInTheDocument();
    expect(bubble.textContent).toBe('Bot reply');
  });

  it('renders multiple messages in order', () => {
    const messages = [
      makeMsg({ id: '1', role: 'user', parts: [{ type: 'text', text: 'First' }] }),
      makeMsg({ id: '2', role: 'assistant', parts: [{ type: 'text', text: 'Second' }] }),
      makeMsg({ id: '3', role: 'user', parts: [{ type: 'text', text: 'Third' }] }),
    ];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const bubbles = container.querySelectorAll('.ai-chat-bubble');
    expect(bubbles).toHaveLength(3);
    expect(bubbles[0].textContent).toBe('First');
    expect(bubbles[1].textContent).toBe('Second');
    expect(bubbles[2].textContent).toBe('Third');
  });

  it('shows typing indicator when status is submitted', () => {
    const messages = [];
    const { container } = render(<AiChatMessages messages={messages} status="submitted" />);

    expect(container.querySelector('.ai-typing-indicator')).toBeInTheDocument();
    expect(container.querySelectorAll('.ai-typing-dot')).toHaveLength(3);
  });

  it('does not show typing indicator when status is ready', () => {
    const messages = [
      makeMsg({ role: 'assistant', parts: [{ type: 'text', text: 'Done' }] }),
    ];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    expect(container.querySelector('.ai-typing-indicator')).not.toBeInTheDocument();
  });

  it('does not show typing indicator when status is streaming', () => {
    const messages = [
      makeMsg({ role: 'assistant', parts: [{ type: 'text', text: 'Partial...' }] }),
    ];
    const { container } = render(<AiChatMessages messages={messages} status="streaming" />);

    // Streaming shows text as it arrives, typing indicator only for submitted (waiting for first token)
    expect(container.querySelector('.ai-typing-indicator')).not.toBeInTheDocument();
  });

  it('renders tool cards for completed tool parts', () => {
    const messages = [
      makeMsg({
        id: '1',
        role: 'assistant',
        parts: [
          { type: 'tool-read_document', toolName: 'read_document', state: 'output-available', args: {}, output: {} },
          { type: 'text', text: 'Here is the document content.' },
        ],
      }),
    ];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const card = container.querySelector('.ai-tool-card');
    expect(card).toBeInTheDocument();
    expect(card.textContent).toContain('Reading document');
    expect(card).toHaveClass('ai-tool-card--complete');
  });

  it('renders tool cards for running tool parts', () => {
    const messages = [
      makeMsg({
        id: '1',
        role: 'assistant',
        parts: [
          { type: 'tool-list_documents', toolName: 'list_documents', state: 'call', args: {} },
        ],
      }),
    ];
    const { container } = render(<AiChatMessages messages={messages} status="streaming" />);

    const card = container.querySelector('.ai-tool-card');
    expect(card).toBeInTheDocument();
    expect(card.textContent).toContain('Listing documents');
    expect(card).toHaveClass('ai-tool-card--running');
  });

  it('renders markdown bold and links in assistant messages', () => {
    const messages = [
      makeMsg({
        id: '1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'This is **bold** and a [link](https://example.com).' }],
      }),
    ];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    expect(container.querySelector('strong').textContent).toBe('bold');
    const link = container.querySelector('a');
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('groups consecutive tool cards into a tool group', () => {
    const messages = [
      makeMsg({
        id: '1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Let me search.' },
          { type: 'tool-webSearch', toolName: 'webSearch', state: 'output-available', args: {}, output: {} },
          { type: 'tool-webSearch', toolName: 'webSearch', state: 'output-available', args: {}, output: {} },
          { type: 'text', text: 'Found results.' },
        ],
      }),
    ];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const toolGroup = container.querySelector('.ai-tool-group');
    expect(toolGroup).toBeInTheDocument();
    expect(toolGroup.querySelectorAll('.ai-tool-card')).toHaveLength(2);
  });

  it('auto-scrolls to bottom when messages change', () => {
    const messages = [makeMsg({ id: '1' })];
    const { container, rerender } = render(<AiChatMessages messages={messages} status="ready" />);

    const scrollEl = container.querySelector('.ai-chat-messages');
    // Mock scrollHeight to simulate content taller than container
    Object.defineProperty(scrollEl, 'scrollHeight', { value: 500, configurable: true });

    const updated = [...messages, makeMsg({ id: '2' })];
    rerender(<AiChatMessages messages={updated} status="ready" />);

    expect(scrollEl.scrollTop).toBe(500);
  });
});
