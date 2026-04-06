import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AiChatHistory from '../AiChatHistory';

function makeAiChat(overrides = {}) {
  return {
    chatList: [],
    currentChatId: null,
    createChat: vi.fn().mockResolvedValue('new-id'),
    selectChat: vi.fn(),
    deleteChat: vi.fn().mockResolvedValue(),
    renameChat: vi.fn().mockResolvedValue(),
    loadMoreChats: vi.fn().mockResolvedValue(),
    hasMoreChats: false,
    ...overrides,
  };
}

describe('AiChatHistory', () => {
  let onBack;

  beforeEach(() => {
    onBack = vi.fn();
    vi.clearAllMocks();
  });

  it('renders "New Chat" button', () => {
    render(<AiChatHistory aiChat={makeAiChat()} onBack={onBack} />);
    expect(screen.getByText('New Chat')).toBeInTheDocument();
  });

  it('renders search input', () => {
    render(<AiChatHistory aiChat={makeAiChat()} onBack={onBack} />);
    expect(screen.getByPlaceholderText('Search chats...')).toBeInTheDocument();
  });

  it('shows empty state when no chats', () => {
    render(<AiChatHistory aiChat={makeAiChat()} onBack={onBack} />);
    expect(screen.getByText('No chats yet')).toBeInTheDocument();
  });

  it('renders chat list items', () => {
    const chatList = [
      { id: '1', title: 'First Chat', updatedAt: new Date().toISOString() },
      { id: '2', title: 'Second Chat', updatedAt: new Date().toISOString() },
    ];
    render(<AiChatHistory aiChat={makeAiChat({ chatList })} onBack={onBack} />);

    expect(screen.getByText('First Chat')).toBeInTheDocument();
    expect(screen.getByText('Second Chat')).toBeInTheDocument();
  });

  it('shows "New Chat" for untitled chats', () => {
    const chatList = [
      { id: '1', title: null, updatedAt: new Date().toISOString() },
    ];
    render(<AiChatHistory aiChat={makeAiChat({ chatList })} onBack={onBack} />);

    // "New Chat" appears both as the button and as the untitled chat's title
    const newChatElements = screen.getAllByText('New Chat');
    expect(newChatElements.length).toBeGreaterThanOrEqual(2);
  });

  it('highlights active chat', () => {
    const chatList = [
      { id: '1', title: 'Active', updatedAt: new Date().toISOString() },
      { id: '2', title: 'Inactive', updatedAt: new Date().toISOString() },
    ];
    const { container } = render(
      <AiChatHistory aiChat={makeAiChat({ chatList, currentChatId: '1' })} onBack={onBack} />
    );

    const activeItem = container.querySelector('.ai-chat-history-item--active');
    expect(activeItem).toBeInTheDocument();
    expect(activeItem.textContent).toContain('Active');
  });

  it('clicking a chat calls selectChat and onBack', () => {
    const selectChat = vi.fn();
    const chatList = [
      { id: '1', title: 'Click Me', updatedAt: new Date().toISOString() },
    ];
    render(
      <AiChatHistory aiChat={makeAiChat({ chatList, selectChat })} onBack={onBack} />
    );

    fireEvent.click(screen.getByText('Click Me'));
    expect(selectChat).toHaveBeenCalledWith('1');
    expect(onBack).toHaveBeenCalled();
  });

  it('"New Chat" button calls createChat and onBack', async () => {
    const createChat = vi.fn().mockResolvedValue('new-id');
    render(
      <AiChatHistory aiChat={makeAiChat({ createChat })} onBack={onBack} />
    );

    fireEvent.click(screen.getByText('New Chat'));

    await waitFor(() => {
      expect(createChat).toHaveBeenCalled();
      expect(onBack).toHaveBeenCalled();
    });
  });

  it('filters chats by search query', async () => {
    const user = userEvent.setup();
    const chatList = [
      { id: '1', title: 'API Design', updatedAt: new Date().toISOString() },
      { id: '2', title: 'Bug Fix', updatedAt: new Date().toISOString() },
    ];
    render(<AiChatHistory aiChat={makeAiChat({ chatList })} onBack={onBack} />);

    await user.type(screen.getByPlaceholderText('Search chats...'), 'api');

    expect(screen.getByText('API Design')).toBeInTheDocument();
    expect(screen.queryByText('Bug Fix')).not.toBeInTheDocument();
  });

  it('shows "No matching chats" when search has no results', async () => {
    const user = userEvent.setup();
    const chatList = [
      { id: '1', title: 'Test Chat', updatedAt: new Date().toISOString() },
    ];
    render(<AiChatHistory aiChat={makeAiChat({ chatList })} onBack={onBack} />);

    await user.type(screen.getByPlaceholderText('Search chats...'), 'zzzzz');

    expect(screen.getByText('No matching chats')).toBeInTheDocument();
  });

  it('delete requires confirmation click', async () => {
    const deleteChat = vi.fn().mockResolvedValue();
    const chatList = [
      { id: '1', title: 'Delete Me', updatedAt: new Date().toISOString() },
    ];
    render(
      <AiChatHistory aiChat={makeAiChat({ chatList, deleteChat })} onBack={onBack} />
    );

    // Hover to reveal action buttons
    const item = screen.getByText('Delete Me').closest('.ai-chat-history-item');

    // Click the delete button
    const deleteBtn = item.querySelector('[title="Delete"]');
    fireEvent.click(deleteBtn);

    // Should show confirm/cancel buttons, not yet call deleteChat
    expect(deleteChat).not.toHaveBeenCalled();

    // Click the confirm button
    const confirmBtn = item.querySelector('[title="Confirm delete"]');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(deleteChat).toHaveBeenCalledWith('1');
    });
  });
});
