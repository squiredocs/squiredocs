import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import AiChatMessages from '../AiChatMessages';

// UndoEditButton (rendered after a modify diff) calls useAuth() for the axios
// client. Other tests never mount it, so a module-level mock is safe here.
const mockGet = vi.fn();
const mockPost = vi.fn();
// `api` must be a STABLE reference across renders — components depend on it in
// useCallback/useEffect deps, so a fresh object each call causes an effect loop.
const mockApi = { get: mockGet, post: mockPost };
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ api: mockApi }),
}));
// Mock the chat context so the test doesn't pull the heavy AI SDK chain, and so
// the undo/redo persistence calls have a known chatId.
vi.mock('../../contexts/AiChatContext', () => ({
  useAiChat: () => ({ currentChatId: 'chat-1' }),
}));

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

  it('merges consecutive assistant text parts into one block (no spurious break)', () => {
    // Anthropic can split one paragraph across content blocks (thinking/step
    // boundaries) — the pieces must render as a single markdown block.
    const messages = [makeMsg({
      role: 'assistant',
      parts: [
        { type: 'text', text: 'The quick brown fox ' },
        { type: 'step-start' },
        { type: 'text', text: 'jumps over the lazy dog.' },
      ],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const blocks = container.querySelectorAll('.ai-chat-markdown');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].querySelectorAll('p')).toHaveLength(1);
    expect(blocks[0]).toHaveTextContent('The quick brown fox jumps over the lazy dog.');
  });

  it('keeps text parts separated by a tool call as distinct blocks', () => {
    const messages = [makeMsg({
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool-read_document', toolCallId: 't1', state: 'output-available', input: { docGuid: 'd1' }, output: {} },
        { type: 'text', text: 'Done reading.' },
      ],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const blocks = container.querySelectorAll('.ai-chat-markdown');
    expect(blocks).toHaveLength(2);
  });

  it('hides the onboarding welcome-kickoff message from the transcript', () => {
    const messages = [
      makeMsg({ id: 'k', role: 'user', metadata: { kind: 'welcome-kickoff' }, parts: [{ type: 'text', text: 'SECRET KICKOFF PROMPT' }] }),
      makeMsg({ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Hi there!' }] }),
    ];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    const bubbles = container.querySelectorAll('.ai-chat-bubble');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toHaveTextContent('Hi there!');
    expect(container).not.toHaveTextContent('SECRET KICKOFF PROMPT');
  });

  it('shows a typing bubble while the kickoff is the only message and a reply is streaming', () => {
    const messages = [
      makeMsg({ id: 'k', role: 'user', metadata: { kind: 'welcome-kickoff' }, parts: [{ type: 'text', text: 'kickoff' }] }),
    ];
    const { container } = render(<AiChatMessages messages={messages} status="submitted" />);

    // No user bubble (kickoff hidden), but the assistant typing indicator shows.
    expect(container.querySelector('.ai-chat-bubble--user')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-typing-indicator')).toBeInTheDocument();
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

  it('resolves an attachment: reference to a presigned URL before rendering', async () => {
    mockGet.mockReset();
    mockGet.mockResolvedValueOnce({ data: { url: 'https://s3.example/signed/x?sig=1' } });
    const messages = [makeMsg({
      role: 'user',
      content: '',
      parts: [
        { type: 'file', mediaType: 'image/png', url: 'attachment:chat-attachments/u/11111111-1111-1111-1111-111111111111', filename: 'shot.png' },
      ],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);

    // Placeholder first (no browsable URL yet), then the resolved <img>.
    expect(container.querySelector('.ai-chat-image--loading')).toBeInTheDocument();
    await waitFor(() => {
      const img = container.querySelector('img.ai-chat-image');
      expect(img).toBeInTheDocument();
      expect(img.getAttribute('src')).toBe('https://s3.example/signed/x?sig=1');
    });
    expect(mockGet).toHaveBeenCalledWith('/api/chat/attachments/resolve', {
      params: { ref: 'attachment:chat-attachments/u/11111111-1111-1111-1111-111111111111' },
    });
  });

  it('shows an "Image unavailable" placeholder when a reference fails to resolve', async () => {
    mockGet.mockReset();
    mockGet.mockRejectedValueOnce(new Error('403'));
    const messages = [makeMsg({
      role: 'user',
      content: '',
      parts: [
        { type: 'file', mediaType: 'image/png', url: 'attachment:chat-attachments/u/22222222-2222-2222-2222-222222222222', filename: 'x.png' },
      ],
    })];
    const { container } = render(<AiChatMessages messages={messages} status="ready" />);
    await waitFor(() => {
      expect(container.querySelector('.ai-chat-image--error')).toBeInTheDocument();
    });
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

  // --------------- Undo/redo on agent edits ---------------

  const modifyPart = (output, docGuid = 'doc-123', extra = {}) => ({
    type: 'tool-modify',
    toolName: 'modify',
    toolCallId: 'tc-1',
    state: 'output-available',
    input: { docGuid },
    output,
    ...extra,
  });

  const makeModifyMsg = (output, docGuid, extra) => makeMsg({
    role: 'assistant',
    parts: [modifyPart(output, docGuid, extra)],
  });

  const diffOutput = {
    changed: true,
    diff: { lines: ['-old', '+new'], hunkStarts: [{ index: 0, oldStart: 1, newStart: 1 }] },
  };

  const undoAvailable = { data: { canUndo: true, canRedo: false } };
  const redoAvailable = { data: { canUndo: false, canRedo: true } };

  it('shows an Undo edit button when undo is available', async () => {
    mockGet.mockReset();
    mockGet.mockResolvedValue(undoAvailable);
    const { findByRole } = render(
      <AiChatMessages messages={[makeModifyMsg(diffOutput)]} status="ready" />,
    );
    expect(await findByRole('button', { name: 'Undo edit' })).toBeInTheDocument();
  });

  it('does NOT show the button when undo is no longer available (session expired)', async () => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({ data: { canUndo: false, canRedo: false } });
    const { queryByRole } = render(
      <AiChatMessages messages={[makeModifyMsg(diffOutput)]} status="ready" />,
    );
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/docs/doc-123/undo-status'));
    expect(queryByRole('button', { name: /undo edit/i })).not.toBeInTheDocument();
  });

  it('hides the button when the edit made no change', () => {
    mockGet.mockReset();
    mockGet.mockResolvedValue(undoAvailable);
    const { queryByRole } = render(
      <AiChatMessages messages={[makeModifyMsg({ changed: false })]} status="ready" />,
    );
    expect(queryByRole('button', { name: /undo edit/i })).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled(); // not even the latest modify -> not mounted
  });

  it('only renders the button on the most recent modify (LIFO undo stack)', async () => {
    mockGet.mockReset();
    mockGet.mockResolvedValue(undoAvailable);
    const messages = [
      makeMsg({ id: 'a', role: 'assistant', parts: [modifyPart(diffOutput, 'doc-1')] }),
      makeMsg({ id: 'b', role: 'assistant', parts: [modifyPart(diffOutput, 'doc-2')] }),
    ];
    const { findAllByRole } = render(<AiChatMessages messages={messages} status="ready" />);
    const buttons = await findAllByRole('button', { name: 'Undo edit' });
    expect(buttons).toHaveLength(1);
    // Only the latest edit's status is ever queried.
    expect(mockGet).toHaveBeenCalledWith('/api/docs/doc-2/undo-status');
    expect(mockGet).not.toHaveBeenCalledWith('/api/docs/doc-1/undo-status');
  });

  it('calls /undo and flips to Redo, then /redo flips back', async () => {
    mockGet.mockReset();
    mockGet
      .mockResolvedValueOnce(undoAvailable)   // initial
      .mockResolvedValueOnce(redoAvailable)   // after undo
      .mockResolvedValueOnce(undoAvailable);  // after redo
    mockPost.mockReset();
    mockPost
      .mockResolvedValueOnce({ data: { success: true, undone: true } })
      .mockResolvedValueOnce({ data: { success: true, redone: true } });
    const { findByRole } = render(
      <AiChatMessages messages={[makeModifyMsg(diffOutput)]} status="ready" />,
    );

    fireEvent.click(await findByRole('button', { name: 'Undo edit' }));
    expect(await findByRole('button', { name: 'Redo edit' })).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledWith('/api/docs/doc-123/undo', { chatId: 'chat-1', toolCallId: 'tc-1' });

    fireEvent.click(await findByRole('button', { name: 'Redo edit' }));
    expect(await findByRole('button', { name: 'Undo edit' })).toBeInTheDocument();
    expect(mockPost).toHaveBeenLastCalledWith('/api/docs/doc-123/redo', { chatId: 'chat-1', toolCallId: 'tc-1' });
  });

  it('persists reverted: a part flagged reverted renders dimmed with "Reverted" on load', async () => {
    mockGet.mockReset();
    mockGet.mockResolvedValue(redoAvailable);
    const { container, findByText } = render(
      <AiChatMessages messages={[makeModifyMsg(diffOutput, 'doc-123', { reverted: true })]} status="ready" />,
    );
    // No interaction needed — the persisted flag drives the reverted UI.
    expect(await findByText('Reverted')).toBeInTheDocument();
    expect(container.querySelector('.ai-diff-wrap--undone')).toBeInTheDocument();
    // And since it's the latest edit and redo is available, a Redo button shows.
    expect(await findByText('Redo edit')).toBeInTheDocument();
  });

  it('marks the diff as reverted while undone and clears it on redo', async () => {
    mockGet.mockReset();
    mockGet
      .mockResolvedValueOnce(undoAvailable)
      .mockResolvedValueOnce(redoAvailable)
      .mockResolvedValueOnce(undoAvailable);
    mockPost.mockReset();
    mockPost
      .mockResolvedValueOnce({ data: { success: true, undone: true } })
      .mockResolvedValueOnce({ data: { success: true, redone: true } });
    const { findByRole, container, queryByText } = render(
      <AiChatMessages messages={[makeModifyMsg(diffOutput)]} status="ready" />,
    );

    fireEvent.click(await findByRole('button', { name: 'Undo edit' }));
    await waitFor(() => expect(container.querySelector('.ai-diff-wrap--undone')).toBeInTheDocument());
    expect(queryByText('Reverted')).toBeInTheDocument();

    fireEvent.click(await findByRole('button', { name: 'Redo edit' }));
    await waitFor(() => expect(container.querySelector('.ai-diff-wrap--undone')).toBeNull());
    expect(queryByText('Reverted')).toBeNull();
  });

  it('shows an inline error when the request fails', async () => {
    mockGet.mockReset();
    mockGet.mockResolvedValue(undoAvailable);
    mockPost.mockReset();
    mockPost.mockRejectedValue({ response: { data: { error: 'No permission' } } });
    const { findByRole, findByText } = render(
      <AiChatMessages messages={[makeModifyMsg(diffOutput)]} status="ready" />,
    );

    fireEvent.click(await findByRole('button', { name: 'Undo edit' }));
    expect(await findByText('No permission')).toBeInTheDocument();
    expect(await findByRole('button', { name: 'Undo edit' })).toBeInTheDocument();
  });
});

describe('ThinkingBlock live summary', () => {
  // Long enough to clear the THINKING_SUMMARY_MIN_CHARS threshold
  const longReasoning = 'The user wants an outline, so first I should scan the document headings '
    + 'and figure out which sections already exist before drafting anything new.';

  const makeReasoningMsg = (text, extraParts = []) => makeMsg({
    role: 'assistant',
    parts: [{ type: 'reasoning', text }, ...extraParts],
  });

  it('shows a static "Thinking" label and does not poll for completed blocks', () => {
    mockPost.mockReset();
    const { getByText } = render(
      <AiChatMessages messages={[makeReasoningMsg(longReasoning)]} status="ready" />,
    );

    expect(getByText('Thinking')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('polls for a summary while the reasoning block streams and shows it as the label', async () => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({ data: { summary: 'Planning the document outline' } });
    const { findByText } = render(
      <AiChatMessages messages={[makeReasoningMsg(longReasoning)]} status="streaming" />,
    );

    expect(await findByText('Planning the document outline')).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledWith('/api/chat/thinking-summary', { text: longReasoning });
  });

  it('shows "Thinking" instantly, swaps to the summary when it arrives, and never renders the full text', async () => {
    mockPost.mockReset();
    let resolveSummary;
    mockPost.mockReturnValue(new Promise((resolve) => { resolveSummary = resolve; }));
    const { getByText, findByText, container, queryByText } = render(
      <AiChatMessages messages={[makeReasoningMsg(longReasoning)]} status="streaming" />,
    );

    // Initial call is in flight — label reads "Thinking" immediately
    expect(getByText('Thinking')).toBeInTheDocument();

    resolveSummary({ data: { summary: 'Scanning document headings' } });
    expect(await findByText('Scanning document headings')).toBeInTheDocument();

    // The full train of thought is never rendered and there is nothing to expand
    expect(container.querySelector('.ai-thinking-block button')).toBeNull();
    expect(queryByText(/scan the document headings/)).toBeNull();
  });

  it('does not poll while reasoning is too short to summarize', () => {
    mockPost.mockReset();
    render(<AiChatMessages messages={[makeReasoningMsg('Hmm.')]} status="streaming" />);

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('summarizes a below-threshold block once when it completes', async () => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({ data: { summary: 'Brief deliberation' } });

    const shortText = 'Hmm, quick check.'; // below THINKING_SUMMARY_MIN_CHARS
    const streaming = makeMsg({ id: 'm-short', role: 'assistant', parts: [{ type: 'reasoning', text: shortText }] });
    const { rerender, findByText } = render(<AiChatMessages messages={[streaming]} status="streaming" />);
    expect(mockPost).not.toHaveBeenCalled();

    // Thinking ends and the answer arrives — the block gets one catch-up summary
    const done = makeMsg({
      id: 'm-short',
      role: 'assistant',
      parts: [{ type: 'reasoning', text: shortText }, { type: 'text', text: 'The answer.' }],
    });
    rerender(<AiChatMessages messages={[done]} status="ready" />);

    expect(await findByText('Brief deliberation')).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('/api/chat/thinking-summary', { text: shortText });
  });

  it('does not poll a reasoning block that is no longer the trailing group', () => {
    mockPost.mockReset();
    const msg = makeReasoningMsg(longReasoning, [{ type: 'text', text: 'Here is the answer so far' }]);
    render(<AiChatMessages messages={[msg]} status="streaming" />);

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('recovers a summary that resolves while the block was unmounted (transcript remount)', async () => {
    mockPost.mockReset();
    let resolveSummary;
    mockPost.mockReturnValue(new Promise((r) => { resolveSummary = r; }));

    const streaming = makeMsg({ id: 'm-remount', role: 'assistant', parts: [{ type: 'reasoning', text: longReasoning }] });
    const first = render(<AiChatMessages messages={[streaming]} status="streaming" />);
    await waitFor(() => expect(mockPost).toHaveBeenCalled());

    // The transcript remounts (stream settles / chat reloads) with the request in flight
    first.unmount();
    resolveSummary({ data: { summary: 'Weighing the investment options' } });
    await waitFor(() => {}); // let the resolved request write the summary cache

    const done = makeMsg({
      id: 'm-remount',
      role: 'assistant',
      parts: [{ type: 'reasoning', text: longReasoning }, { type: 'text', text: 'Answer' }],
    });
    const { findByText } = render(<AiChatMessages messages={[done]} status="ready" />);
    expect(await findByText('Weighing the investment options')).toBeInTheDocument();
  });
});
