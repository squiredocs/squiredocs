/**
 * The assistant's setup state (no usable key): standalone copy + actions, and how
 * the side panel swaps it in for the composer.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockSpaNavigate = vi.fn();
vi.mock('../../utils/navigation', () => ({ spaNavigate: (...a) => mockSpaNavigate(...a) }));

let mockUser = { name: 'Test User' };
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));
vi.mock('../../hooks/useMobile', () => ({ useMobile: () => false }));
vi.mock('../../hooks/useResizeHandle', () => ({
  useResizeHandle: () => ({ handleMouseDown: vi.fn(), handleTouchStart: vi.fn(), isDragging: false }),
}));
let mockByok = {};
vi.mock('../../contexts/ByokContext', () => ({
  useByok: () => ({ settings: null, activeModelLabel: null, loading: false, accentColor: '#7c3aed', canAttachImages: true, ...mockByok }),
}));

const { default: AssistantSetupState, ASSISTANT_KEY_SETTINGS_PATH } = await import('../AssistantSetupState');
const { default: AiPanel } = await import('../AiPanel');

const ADMIN_LINE = /ANTHROPIC_API_KEY/;

describe('AssistantSetupState', () => {
  beforeEach(() => { mockSpaNavigate.mockClear(); });

  it('explains the key, offers Settings, and notes MCP agents need no key', () => {
    render(<AssistantSetupState />);
    expect(screen.getByText('The Squire Docs assistant needs an AI key')).toBeTruthy();
    expect(screen.getByText(/Add your own key in Settings/)).toBeTruthy();
    expect(screen.getByText(/Coding agents connected over MCP work without a key/)).toBeTruthy();
    expect(screen.getByText(/Connect your coding agents/)).toBeTruthy();
  });

  it('hides the instance .env line from a non-admin', () => {
    render(<AssistantSetupState isAdmin={false} />);
    expect(screen.queryByTestId('assistant-setup-admin')).toBeNull();
    expect(screen.queryByText(ADMIN_LINE)).toBeNull();
  });

  it('shows the instance .env line to an admin', () => {
    render(<AssistantSetupState isAdmin />);
    const line = screen.getByTestId('assistant-setup-admin');
    expect(line.textContent).toBe(
      "To turn it on for everyone on this instance, set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in the instance's .env file and restart with docker compose up -d.",
    );
  });

  it('Open Settings goes to the BYOK section', () => {
    const onNavigate = vi.fn();
    render(<AssistantSetupState onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(mockSpaNavigate).toHaveBeenCalledWith(ASSISTANT_KEY_SETTINGS_PATH);
    expect(ASSISTANT_KEY_SETTINGS_PATH).toBe('/settings#assistant-key');
    expect(onNavigate).toHaveBeenCalled();
  });

  it('uses no em dashes and always says "Squire Docs"', () => {
    const { container } = render(<AssistantSetupState isAdmin />);
    const text = container.textContent;
    expect(text).not.toMatch(/—/);
    expect(text.match(/Squire(?! Docs)/g)).toBeNull();
  });
});

describe('AiPanel with no usable key', () => {
  const aiPanel = {
    isOpen: true, open: vi.fn(), close: vi.fn(), position: 'right', setPosition: vi.fn(),
    widthPx: 380, updateWidth: vi.fn(), heightPx: 300, updateHeight: vi.fn(),
  };
  const aiChat = (overrides = {}) => ({
    messages: [], sendMessage: vi.fn(), status: 'ready', stop: vi.fn(), chatList: [], currentChatId: null,
    createChat: vi.fn(), selectChat: vi.fn(), deleteChat: vi.fn(), renameChat: vi.fn(),
    refreshChatList: vi.fn(), loadMoreChats: vi.fn(), hasMoreChats: false, ...overrides,
  });

  beforeEach(() => {
    mockUser = { name: 'Test User' };
    mockByok = {};
  });

  it('shows the setup state instead of the greeting and composer', () => {
    mockByok = { assistantUnavailable: true };
    render(<AiPanel aiPanel={aiPanel} aiChat={aiChat()} />);
    expect(screen.getByTestId('assistant-setup')).toBeTruthy();
    expect(screen.queryByPlaceholderText('How can I help you?')).toBeNull();
    expect(screen.queryByText(/Test/)).toBeNull(); // no "Good morning, Test" greeting
  });

  it('shows the .env line only to an admin', () => {
    mockByok = { assistantUnavailable: true };
    const { unmount } = render(<AiPanel aiPanel={aiPanel} aiChat={aiChat()} />);
    expect(screen.queryByTestId('assistant-setup-admin')).toBeNull();
    unmount();

    mockUser = { name: 'Owner', isAdmin: true };
    render(<AiPanel aiPanel={aiPanel} aiChat={aiChat()} />);
    expect(screen.getByTestId('assistant-setup-admin')).toBeTruthy();
  });

  it('keeps earlier messages readable above the setup state', () => {
    mockByok = { assistantUnavailable: true };
    const messages = [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'Earlier reply' }] }];
    render(<AiPanel aiPanel={aiPanel} aiChat={aiChat({ messages })} />);
    expect(screen.getByText('Earlier reply')).toBeTruthy();
    expect(screen.getByTestId('assistant-setup')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Reply...')).toBeNull();
  });

  it('renders the normal composer when the assistant is available', () => {
    mockByok = { assistantUnavailable: false };
    render(<AiPanel aiPanel={aiPanel} aiChat={aiChat()} />);
    expect(screen.queryByTestId('assistant-setup')).toBeNull();
    expect(screen.getByPlaceholderText('How can I help you?')).toBeTruthy();
  });
});
