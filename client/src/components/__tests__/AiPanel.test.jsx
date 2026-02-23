import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AiPanel from '../AiPanel';

// Mock useMobile
let mockIsMobile = false;
vi.mock('../../hooks/useMobile', () => ({
  useMobile: () => mockIsMobile,
}));

// Mock useResizeHandle
const mockWidthResize = { handleMouseDown: vi.fn(), handleTouchStart: vi.fn(), isDragging: false };
const mockHeightResize = { handleMouseDown: vi.fn(), handleTouchStart: vi.fn(), isDragging: false };
vi.mock('../../hooks/useResizeHandle', () => ({
  useResizeHandle: (direction) =>
    direction === 'horizontal' ? mockWidthResize : mockHeightResize,
}));

function makeAiPanel(overrides = {}) {
  return {
    isOpen: true,
    setIsOpen: vi.fn(),
    position: 'right',
    setPosition: vi.fn(),
    widthPx: 380,
    updateWidth: vi.fn(),
    heightPx: 300,
    updateHeight: vi.fn(),
    messages: [],
    sendMessage: vi.fn(),
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
    const { container } = render(<AiPanel aiPanel={makeAiPanel({ isOpen: false })} />);
    expect(container.firstChild).toBeNull();
  });

  // --------------- Desktop ---------------

  it('renders desktop panel as aside with right position', () => {
    const { container } = render(<AiPanel aiPanel={makeAiPanel()} />);

    const aside = container.querySelector('aside.ai-panel');
    expect(aside).toBeInTheDocument();
    expect(aside).toHaveClass('ai-panel--right');
  });

  it('applies width CSS variable for right position', () => {
    const { container } = render(<AiPanel aiPanel={makeAiPanel({ widthPx: 420 })} />);

    const aside = container.querySelector('aside.ai-panel');
    expect(aside.style.getPropertyValue('--ai-panel-width')).toBe('420px');
  });

  it('renders desktop panel with bottom position', () => {
    const { container } = render(<AiPanel aiPanel={makeAiPanel({ position: 'bottom' })} />);

    const aside = container.querySelector('aside.ai-panel');
    expect(aside).toHaveClass('ai-panel--bottom');
    expect(aside.style.getPropertyValue('--ai-panel-height')).toBe('300px');
  });

  it('renders resize handle on desktop', () => {
    const { container } = render(<AiPanel aiPanel={makeAiPanel()} />);

    expect(container.querySelector('.ai-panel-resize-handle')).toBeInTheDocument();
  });

  it('renders position toggle button on desktop', () => {
    render(<AiPanel aiPanel={makeAiPanel()} />);

    expect(screen.getByRole('button', { name: /Move to bottom/i })).toBeInTheDocument();
  });

  it('position toggle switches position', () => {
    const setPosition = vi.fn();
    render(<AiPanel aiPanel={makeAiPanel({ setPosition })} />);

    fireEvent.click(screen.getByRole('button', { name: /Move to bottom/i }));
    expect(setPosition).toHaveBeenCalledWith('bottom');
  });

  it('close button calls setIsOpen(false) on desktop', () => {
    const setIsOpen = vi.fn();
    render(<AiPanel aiPanel={makeAiPanel({ setIsOpen })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(setIsOpen).toHaveBeenCalledWith(false);
  });

  it('shows panel title on desktop', () => {
    render(<AiPanel aiPanel={makeAiPanel()} />);
    expect(screen.getByText('AI Assistant')).toBeInTheDocument();
  });

  // --------------- Mobile ---------------

  it('renders mobile full-screen panel', () => {
    mockIsMobile = true;
    const { container } = render(<AiPanel aiPanel={makeAiPanel()} />);

    expect(container.querySelector('.ai-panel-mobile')).toBeInTheDocument();
    // Should not render the desktop aside
    expect(container.querySelector('aside.ai-panel')).not.toBeInTheDocument();
  });

  it('close button calls setIsOpen(false) on mobile', () => {
    mockIsMobile = true;
    const setIsOpen = vi.fn();
    render(<AiPanel aiPanel={makeAiPanel({ setIsOpen })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(setIsOpen).toHaveBeenCalledWith(false);
  });

  it('does not render position toggle or resize handle on mobile', () => {
    mockIsMobile = true;
    const { container } = render(<AiPanel aiPanel={makeAiPanel()} />);

    expect(container.querySelector('.ai-panel-resize-handle')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move to/i })).not.toBeInTheDocument();
  });

  // --------------- Streaming ---------------

  it('disables input when last message is streaming', () => {
    const messages = [
      { id: '1', role: 'user', content: 'Hi', status: 'complete', timestamp: Date.now() },
      { id: '2', role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() },
    ];
    const { container } = render(<AiPanel aiPanel={makeAiPanel({ messages })} />);

    const sendBtn = screen.getByRole('button', { name: 'Send message' });
    expect(sendBtn).toBeDisabled();
  });
});
