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

// Mock WindowPortal to render children inline (jsdom has no window.open)
vi.mock('../WindowPortal', () => ({
  default: ({ children }) => <div data-testid="window-portal">{children}</div>,
}));

function makeAiPanel(overrides = {}) {
  return {
    isOpen: true,
    setIsOpen: vi.fn(),
    close: vi.fn(),
    position: 'right',
    setPosition: vi.fn(),
    widthPx: 380,
    updateWidth: vi.fn(),
    heightPx: 300,
    updateHeight: vi.fn(),
    messages: [],
    sendMessage: vi.fn(),
    isPoppedOut: false,
    popOut: vi.fn(),
    popIn: vi.fn(),
    setPopupWindow: vi.fn(),
    focusPopup: vi.fn(),
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

  it('close button calls close on desktop', () => {
    const close = vi.fn();
    render(<AiPanel aiPanel={makeAiPanel({ close })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalled();
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

  it('close button calls close on mobile', () => {
    mockIsMobile = true;
    const close = vi.fn();
    render(<AiPanel aiPanel={makeAiPanel({ close })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalled();
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

  // --------------- Pop-out ---------------

  it('renders pop-out button on desktop', () => {
    render(<AiPanel aiPanel={makeAiPanel()} />);
    expect(screen.getByRole('button', { name: 'Pop out' })).toBeInTheDocument();
  });

  it('pop-out button is hidden on mobile', () => {
    mockIsMobile = true;
    render(<AiPanel aiPanel={makeAiPanel()} />);
    expect(screen.queryByRole('button', { name: 'Pop out' })).not.toBeInTheDocument();
  });

  it('pop-out button calls popOut', () => {
    const popOut = vi.fn();
    render(<AiPanel aiPanel={makeAiPanel({ popOut })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pop out' }));
    expect(popOut).toHaveBeenCalled();
  });

  it('shows dock button instead of pop-out and position toggle when popped out', () => {
    render(<AiPanel aiPanel={makeAiPanel({ isPoppedOut: true })} />);

    expect(screen.getByRole('button', { name: 'Dock panel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pop out' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move to/i })).not.toBeInTheDocument();
  });

  it('dock button calls popIn', () => {
    const popIn = vi.fn();
    render(<AiPanel aiPanel={makeAiPanel({ isPoppedOut: true, popIn })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dock panel' }));
    expect(popIn).toHaveBeenCalled();
  });

  it('hides resize handle when popped out', () => {
    const { container } = render(<AiPanel aiPanel={makeAiPanel({ isPoppedOut: true })} />);
    expect(container.querySelector('.ai-panel-resize-handle')).not.toBeInTheDocument();
  });

  it('uses popup class when popped out', () => {
    const { container } = render(<AiPanel aiPanel={makeAiPanel({ isPoppedOut: true })} />);
    expect(container.querySelector('.ai-panel--popup')).toBeInTheDocument();
  });
});
