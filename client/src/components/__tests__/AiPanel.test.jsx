import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AiPanel from '../AiPanel';

// Mock useAuth
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Test User' } }),
}));

// Mock useMobile
let mockIsMobile = false;
vi.mock('../../hooks/useMobile', () => ({
  useMobile: () => mockIsMobile,
}));

// Mock useByok
vi.mock('../../contexts/ByokContext', () => ({
  useByok: () => ({ settings: null, loading: false, saving: false, error: null, saveSettings: vi.fn(), clearKey: vi.fn(), accentColor: '#7c3aed' }),
}));

// Mock useResizeHandle
const mockWidthResize = { handleMouseDown: vi.fn(), handleTouchStart: vi.fn(), isDragging: false };
const mockHeightResize = { handleMouseDown: vi.fn(), handleTouchStart: vi.fn(), isDragging: false };
vi.mock('../../hooks/useResizeHandle', () => ({
  useResizeHandle: (direction) =>
    direction === 'horizontal' ? mockWidthResize : mockHeightResize,
}));

// Mock AiChatHistory (tested separately)
vi.mock('../AiChatHistory', () => ({
  default: ({ onBack }) => (
    <div data-testid="ai-chat-history">
      <button onClick={onBack}>Back to chat</button>
    </div>
  ),
}));

function makeAiPanel(overrides = {}) {
  return {
    isOpen: true,
    open: vi.fn(),
    close: vi.fn(),
    position: 'right',
    setPosition: vi.fn(),
    widthPx: 380,
    updateWidth: vi.fn(),
    heightPx: 300,
    updateHeight: vi.fn(),
    ...overrides,
  };
}

function makeAiChat(overrides = {}) {
  return {
    messages: [],
    sendMessage: vi.fn(),
    status: 'ready',
    stop: vi.fn(),
    chatList: [],
    currentChatId: null,
    createChat: vi.fn(),
    selectChat: vi.fn(),
    deleteChat: vi.fn(),
    renameChat: vi.fn(),
    refreshChatList: vi.fn(),
    loadMoreChats: vi.fn(),
    hasMoreChats: false,
    ...overrides,
  };
}

describe('AiPanel', () => {
  beforeEach(() => {
    mockIsMobile = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when not open', () => {
    const { container } = render(<AiPanel aiPanel={makeAiPanel({ isOpen: false })} aiChat={makeAiChat()} />);
    expect(container.firstChild).toBeNull();
  });

  // --------------- Desktop ---------------

  it('renders desktop panel as aside with right position', () => {
    const { container } = render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} />);

    const aside = container.querySelector('aside.ai-panel');
    expect(aside).toBeInTheDocument();
    expect(aside).toHaveClass('ai-panel--right');
  });

  it('applies width CSS variable for right position', () => {
    const { container } = render(<AiPanel aiPanel={makeAiPanel({ widthPx: 420 })} aiChat={makeAiChat()} />);

    const aside = container.querySelector('aside.ai-panel');
    expect(aside.style.getPropertyValue('--ai-panel-width')).toBe('420px');
  });

  it('renders desktop panel with bottom position', () => {
    const { container } = render(<AiPanel aiPanel={makeAiPanel({ position: 'bottom' })} aiChat={makeAiChat()} />);

    const aside = container.querySelector('aside.ai-panel');
    expect(aside).toHaveClass('ai-panel--bottom');
    expect(aside.style.getPropertyValue('--ai-panel-height')).toBe('300px');
  });

  it('renders resize handle on desktop', () => {
    const { container } = render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} />);

    expect(container.querySelector('.ai-panel-resize-handle')).toBeInTheDocument();
  });

  it('renders position toggle button on desktop', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} />);

    expect(screen.getByRole('button', { name: /Move to bottom/i })).toBeInTheDocument();
  });

  it('position toggle switches position', () => {
    const setPosition = vi.fn();
    render(<AiPanel aiPanel={makeAiPanel({ setPosition })} aiChat={makeAiChat()} />);

    fireEvent.click(screen.getByRole('button', { name: /Move to bottom/i }));
    expect(setPosition).toHaveBeenCalledWith('bottom');
  });

  it('close button calls close on desktop', () => {
    const close = vi.fn();
    render(<AiPanel aiPanel={makeAiPanel({ close })} aiChat={makeAiChat()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalled();
  });

  it('shows panel title on desktop', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} />);
    expect(screen.getByText('Squire Docs Assistant')).toBeInTheDocument();
  });

  // --------------- Mobile ---------------

  it('renders mobile full-screen panel', () => {
    mockIsMobile = true;
    const { container } = render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} />);

    expect(container.querySelector('.ai-panel-mobile')).toBeInTheDocument();
    // Should not render the desktop aside
    expect(container.querySelector('aside.ai-panel')).not.toBeInTheDocument();
  });

  it('close button calls close on mobile', () => {
    mockIsMobile = true;
    const close = vi.fn();
    render(<AiPanel aiPanel={makeAiPanel({ close })} aiChat={makeAiChat()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalled();
  });

  it('does not render position toggle or resize handle on mobile', () => {
    mockIsMobile = true;
    const { container } = render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} />);

    expect(container.querySelector('.ai-panel-resize-handle')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move to/i })).not.toBeInTheDocument();
  });

  // --------------- Streaming ---------------

  it('shows stop button when status is streaming', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat({ status: 'streaming' })} />);

    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
  });

  it('shows stop button when status is submitted', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat({ status: 'submitted' })} />);

    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
  });

  // --------------- Chat view toggle ---------------

  it('renders chat view button on desktop when onNavigateToChat is provided', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} onNavigateToChat={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open chat view' })).toBeInTheDocument();
  });

  it('hides chat view button on mobile', () => {
    mockIsMobile = true;
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} onNavigateToChat={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Open chat view' })).not.toBeInTheDocument();
  });

  it('chat view button calls onNavigateToChat', () => {
    const onNavigateToChat = vi.fn();
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} onNavigateToChat={onNavigateToChat} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open chat view' }));
    expect(onNavigateToChat).toHaveBeenCalled();
  });

  // --------------- Chat History ---------------

  it('renders history button on desktop', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} />);
    expect(screen.getByRole('button', { name: 'Chat history' })).toBeInTheDocument();
  });

  it('clicking history button shows history view', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
    expect(screen.getByTestId('ai-chat-history')).toBeInTheDocument();

    // Should hide the chat input
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
  });

  it('shows back button in header when history is visible', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
    // The header should have a back button (aria-label)
    const backButtons = screen.getAllByRole('button', { name: 'Back to chat' });
    expect(backButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('clicking back returns to conversation view', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} />);

    // Open history
    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
    expect(screen.getByTestId('ai-chat-history')).toBeInTheDocument();

    // Click back (from AiChatHistory mock)
    fireEvent.click(screen.getByText('Back to chat'));
    expect(screen.queryByTestId('ai-chat-history')).not.toBeInTheDocument();
  });

  it('history button works on mobile', () => {
    mockIsMobile = true;
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} />);

    expect(screen.getByRole('button', { name: 'Chat history' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
    expect(screen.getByTestId('ai-chat-history')).toBeInTheDocument();
  });

  // --------------- Usage limit ---------------

  it('shows usage limit banner when usageLimitReached is true', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat({ usageLimitReached: true })} />);

    expect(screen.getByText(/You've reached your AI usage limit for this month/)).toBeInTheDocument();
    expect(screen.getByText('View Usage')).toHaveAttribute('href', '/settings');
  });

  it('keeps input usable when usage limit is reached', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat({ usageLimitReached: true })} />);

    // Input should remain functional so users can resend after increasing their limit
    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveAttribute('placeholder', 'How can I help you?');
  });

  it('does not show usage limit banner when not reached', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat({ usageLimitReached: false })} />);

    expect(screen.queryByText(/You've reached your AI usage limit for this month/)).not.toBeInTheDocument();
  });

  // --------------- Generic error ---------------

  it('shows error banner on non-usage-limit error', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat({ status: 'error', error: new Error('Server error') })} />);

    expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
  });

  it('does not show generic error banner when status is ready', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat({ status: 'ready', error: null })} />);

    expect(screen.queryByText('Something went wrong. Please try again.')).not.toBeInTheDocument();
  });

  // --------------- Drag & drop ---------------

  it('shows drop overlay on dragEnter and hides on dragLeave', () => {
    const { container } = render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} />);

    const panel = container.querySelector('.ai-panel');
    fireEvent.dragEnter(panel);
    expect(screen.getByText('Drop files here')).toBeInTheDocument();

    fireEvent.dragLeave(panel);
    expect(screen.queryByText('Drop files here')).not.toBeInTheDocument();
  });

  it('hides drop overlay on drop', () => {
    const { container } = render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat()} />);

    const panel = container.querySelector('.ai-panel');
    fireEvent.dragEnter(panel);
    expect(screen.getByText('Drop files here')).toBeInTheDocument();

    fireEvent.drop(panel, { dataTransfer: { files: [] } });
    expect(screen.queryByText('Drop files here')).not.toBeInTheDocument();
  });

  // --------------- Usage limit (continued) ---------------

  it('shows usage limit banner instead of generic error when both apply', () => {
    render(<AiPanel aiPanel={makeAiPanel()} aiChat={makeAiChat({
      status: 'error',
      error: new Error('usage limit'),
      usageLimitReached: true,
    })} />);

    expect(screen.getByText("You've reached your AI usage limit for this month.")).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong. Please try again.')).not.toBeInTheDocument();
  });
});
