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
    expect(bubble).toHaveTextContent('User text');
  });

  it('renders assistant message with correct class', () => {
    const messages = [makeMsg({ role: 'assistant', parts: [{ type: 'text', text: 'Bot reply' }] })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const bubble = container.querySelector('.ai-chat-bubble--assistant');
    expect(bubble).toBeInTheDocument();
    expect(bubble).toHaveTextContent('Bot reply');
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
    expect(bubbles[0]).toHaveTextContent('First');
    expect(bubbles[1]).toHaveTextContent('Second');
    expect(bubbles[2]).toHaveTextContent('Third');
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
          { type: 'tool-read_document', toolName: 'read_document', state: 'output-available', input: {}, output: {} },
          { type: 'text', text: 'Here is the document content.' },
        ],
      }),
    ];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const card = container.querySelector('.ai-tool-card');
    expect(card).toBeInTheDocument();
    expect(card.textContent).toContain('Reading document');
    const toggle = card.querySelector('.ai-tool-card-toggle');
    expect(toggle).toHaveClass('ai-tool-card--complete');
  });

  it('renders tool cards for running tool parts', () => {
    const messages = [
      makeMsg({
        id: '1',
        role: 'assistant',
        parts: [
          { type: 'tool-list_documents', toolName: 'list_documents', state: 'call', input: {} },
        ],
      }),
    ];
    const { container } = render(<AiChatMessages messages={messages} status="streaming" />);

    const card = container.querySelector('.ai-tool-card');
    expect(card).toBeInTheDocument();
    expect(card.textContent).toContain('Listing documents');
    const toggle = card.querySelector('.ai-tool-card-toggle');
    expect(toggle).toHaveClass('ai-tool-card--running');
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
          { type: 'tool-webSearch', toolName: 'webSearch', state: 'output-available', input: {}, output: {} },
          { type: 'tool-webSearch', toolName: 'webSearch', state: 'output-available', input: {}, output: {} },
          { type: 'text', text: 'Found results.' },
        ],
      }),
    ];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const toolGroup = container.querySelector('.ai-tool-group');
    expect(toolGroup).toBeInTheDocument();
    expect(toolGroup.querySelectorAll('.ai-tool-card')).toHaveLength(2);
  });

  // --------------- Web search tool card ---------------

  it('shows search query inline in webSearch badge', () => {
    const messages = [makeMsg({
      id: '1',
      role: 'assistant',
      parts: [{
        type: 'tool-webSearch',
        toolName: 'webSearch',
        state: 'output-available',
        input: { query: 'quantum computing' },
        output: { text: 'Results here' },
      }],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const toggle = container.querySelector('.ai-tool-card-toggle');
    expect(toggle.textContent).toContain('quantum computing');
    expect(toggle.textContent).toContain('\u2014');
  });

  it('renders web search results when citations present', () => {
    const messages = [makeMsg({
      id: '1',
      role: 'assistant',
      parts: [{
        type: 'tool-webSearch',
        toolName: 'webSearch',
        state: 'output-available',
        input: { query: 'quantum computing' },
        output: {
          text: 'Summary',
          citations: {
            sources: [
              { index: 0, url: 'https://example.com/page1', title: 'Quantum Basics' },
              { index: 1, url: 'https://other.org/article', title: 'Advanced Quantum' },
            ],
          },
        },
      }],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const resultsList = container.querySelector('.ai-web-results-list');
    expect(resultsList).toBeInTheDocument();
    const items = resultsList.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Quantum Basics');
    expect(items[1].textContent).toContain('Advanced Quantum');
    const link = items[0].querySelector('a');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toBe('https://example.com/page1');
  });

  it('renders web search results from source-url parts (Anthropic path)', () => {
    const messages = [makeMsg({
      id: '1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-webSearch',
          toolName: 'webSearch',
          state: 'output-available',
          input: { query: 'quantum computing' },
          output: { text: 'Summary' },
        },
        { type: 'source-url', url: 'https://example.com/page1', title: 'Quantum Basics' },
        { type: 'source-url', url: 'https://other.org/article', title: 'Advanced Quantum' },
      ],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const resultsList = container.querySelector('.ai-web-results-list');
    expect(resultsList).toBeInTheDocument();
    const items = resultsList.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Quantum Basics');
  });

  it('does not render web search results when no citations', () => {
    const messages = [makeMsg({
      id: '1',
      role: 'assistant',
      parts: [{
        type: 'tool-webSearch',
        toolName: 'webSearch',
        state: 'output-available',
        input: { query: 'something' },
        output: { text: 'No results found.' },
      }],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    expect(container.querySelector('.ai-web-results-list')).not.toBeInTheDocument();
  });

  it('does not render web search results while still running', () => {
    const messages = [makeMsg({
      id: '1',
      role: 'assistant',
      parts: [{
        type: 'tool-webSearch',
        toolName: 'webSearch',
        state: 'call',
        input: { query: 'something' },
      }],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="streaming" />);

    expect(container.querySelector('.ai-web-results-list')).not.toBeInTheDocument();
  });

  // --------------- Image rendering ---------------

  it('renders images in user message bubbles', () => {
    const messages = [makeMsg({
      role: 'user',
      parts: [
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc', filename: 'screenshot.png' },
        { type: 'text', text: 'Check this out' },
      ],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const img = container.querySelector('.ai-chat-image');
    expect(img).toBeInTheDocument();
    expect(img.getAttribute('src')).toBe('data:image/png;base64,abc');
    expect(img.getAttribute('alt')).toBe('screenshot.png');
    expect(container.querySelector('.ai-chat-bubble--user').textContent).toContain('Check this out');
  });

  it('renders multiple images in a single user message', () => {
    const messages = [makeMsg({
      role: 'user',
      parts: [
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,a', filename: 'img1.png' },
        { type: 'file', mediaType: 'image/jpeg', url: 'data:image/jpeg;base64,b', filename: 'img2.jpg' },
        { type: 'text', text: 'Two images' },
      ],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const images = container.querySelectorAll('.ai-chat-image');
    expect(images).toHaveLength(2);
    expect(container.querySelector('.ai-chat-images')).toBeInTheDocument();
  });

  it('renders image-only user message (no text)', () => {
    const messages = [makeMsg({
      role: 'user',
      content: '',
      parts: [
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc', filename: 'only-image.png' },
      ],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const img = container.querySelector('.ai-chat-image');
    expect(img).toBeInTheDocument();
    const bubble = container.querySelector('.ai-chat-bubble--user');
    expect(bubble).toBeInTheDocument();
  });

  it('renders user message without images normally', () => {
    const messages = [makeMsg({
      role: 'user',
      parts: [{ type: 'text', text: 'No images here' }],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    expect(container.querySelector('.ai-chat-images')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-chat-image')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-chat-bubble--user')).toHaveTextContent('No images here');
  });

  it('renders non-image file parts as file badges', () => {
    const messages = [makeMsg({
      role: 'user',
      parts: [
        { type: 'file', mediaType: 'application/pdf', url: 'data:application/pdf;base64,abc', filename: 'report.pdf' },
        { type: 'text', text: 'Here is the PDF' },
      ],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    expect(container.querySelector('.ai-chat-file-badge')).toBeInTheDocument();
    expect(container.querySelector('.ai-chat-file-badge span')).toHaveTextContent('report.pdf');
    expect(container.querySelector('.ai-chat-image')).not.toBeInTheDocument();
  });

  // --------------- Document list (list_documents) ---------------

  it('renders document list with links when list_documents completes', () => {
    const messages = [makeMsg({
      id: '1',
      role: 'assistant',
      parts: [{
        type: 'tool-list_documents',
        toolName: 'list_documents',
        state: 'output-available',
        input: {},
        output: {
          documents: [
            { id: 'aaa', title: 'Alpha Doc', role: 'owner' },
            { id: 'bbb', title: 'Beta Doc', role: 'editor' },
          ],
          pagination: { total: 2, limit: 50, offset: 0, hasMore: false },
        },
      }],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const listView = container.querySelector('.ai-doc-list');
    expect(listView).toBeInTheDocument();
    const items = listView.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Alpha Doc');
    expect(items[1].textContent).toContain('Beta Doc');
    // Non-owner role badge shown
    expect(items[1].querySelector('.ai-doc-list-role')).toHaveTextContent('editor');
    // Owner role badge not shown
    expect(items[0].querySelector('.ai-doc-list-role')).toBeNull();
  });

  it('shows search query inline in list_documents badge', () => {
    const messages = [makeMsg({
      id: '1',
      role: 'assistant',
      parts: [{
        type: 'tool-list_documents',
        toolName: 'list_documents',
        state: 'output-available',
        input: { search: 'Cheryl' },
        output: {
          documents: [{ id: 'ccc', title: '1:1 Cheryl : Sam', role: 'owner' }],
          pagination: { total: 1, limit: 50, offset: 0, hasMore: false },
        },
      }],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const toggle = container.querySelector('.ai-tool-card-toggle');
    expect(toggle.textContent).toContain('Cheryl');
    expect(toggle.textContent).toContain('\u2014');
  });

  it('does not render document list when list_documents is still running', () => {
    const messages = [makeMsg({
      id: '1',
      role: 'assistant',
      parts: [{
        type: 'tool-list_documents',
        toolName: 'list_documents',
        state: 'call',
        input: {},
      }],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="streaming" />);

    expect(container.querySelector('.ai-doc-list')).not.toBeInTheDocument();
  });

  it('shows pagination info when hasMore is true', () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      id: `doc-${i}`, title: `Doc ${i}`, role: 'owner',
    }));
    const messages = [makeMsg({
      id: '1',
      role: 'assistant',
      parts: [{
        type: 'tool-list_documents',
        toolName: 'list_documents',
        state: 'output-available',
        input: {},
        output: {
          documents: docs,
          pagination: { total: 25, limit: 10, offset: 0, hasMore: true },
        },
      }],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const more = container.querySelector('.ai-doc-list-more');
    expect(more).toBeInTheDocument();
    expect(more.textContent).toBe('+ 15 more');
  });

  it('does not render document list for empty documents array', () => {
    const messages = [makeMsg({
      id: '1',
      role: 'assistant',
      parts: [{
        type: 'tool-list_documents',
        toolName: 'list_documents',
        state: 'output-available',
        input: {},
        output: { documents: [], pagination: { total: 0, limit: 50, offset: 0, hasMore: false } },
      }],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    expect(container.querySelector('.ai-doc-list')).not.toBeInTheDocument();
  });

  // --------------- Auto-scroll ---------------

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
