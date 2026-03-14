/**
 * SettingsPage Tests
 *
 * Tests the editable name field on the Settings page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsPage from '../SettingsPage';

// Mock useAuth
const mockUpdateUser = vi.fn();
const mockApi = { get: vi.fn().mockRejectedValue(new Error('not available')) };
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    updateUser: mockUpdateUser,
    api: mockApi,
  }),
}));

// Mock child components to keep tests focused
vi.mock('../../components/AgentDelegationList', () => ({
  default: () => <div data-testid="agent-delegation-list" />,
}));
vi.mock('../../components/ApiTokenList', () => ({
  default: () => <div data-testid="api-token-list" />,
}));
vi.mock('../../components/Logo', () => ({
  default: () => <div data-testid="logo" />,
}));
vi.mock('../../contexts/ByokContext', () => ({
  useByok: () => ({
    settings: null,
    loading: false,
    saving: false,
    error: null,
    saveSettings: vi.fn(),
    clearKey: vi.fn(),
  }),
}));

const testUser = {
  email: 'test@example.com',
  name: 'Test User',
  picture: null,
};

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders user name and email', () => {
    render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);

    expect(screen.getByText('test@example.com')).toBeInTheDocument();
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('shows edit button next to name', () => {
    render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);

    expect(screen.getByTitle('Edit name')).toBeInTheDocument();
  });

  it('enters edit mode when edit button is clicked', async () => {
    const user = userEvent.setup();
    render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);

    await user.click(screen.getByTitle('Edit name'));

    expect(screen.getByDisplayValue('Test User')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('cancels editing and restores original name', async () => {
    const user = userEvent.setup();
    render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);

    await user.click(screen.getByTitle('Edit name'));
    const input = screen.getByDisplayValue('Test User');
    await user.clear(input);
    await user.type(input, 'Changed');

    await user.click(screen.getByText('Cancel'));

    // Should be back in display mode with original name
    expect(screen.getByText('Test User')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Changed')).not.toBeInTheDocument();
  });

  it('calls updateUser on save', async () => {
    mockUpdateUser.mockResolvedValue({ ...testUser, name: 'New Name' });
    const user = userEvent.setup();
    render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);

    await user.click(screen.getByTitle('Edit name'));
    const input = screen.getByDisplayValue('Test User');
    await user.clear(input);
    await user.type(input, 'New Name');
    await user.click(screen.getByText('Save'));

    expect(mockUpdateUser).toHaveBeenCalledWith({ name: 'New Name' });
  });

  it('exits edit mode after successful save', async () => {
    mockUpdateUser.mockResolvedValue({ ...testUser, name: 'New Name' });
    const user = userEvent.setup();
    render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);

    await user.click(screen.getByTitle('Edit name'));
    const input = screen.getByDisplayValue('Test User');
    await user.clear(input);
    await user.type(input, 'New Name');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.queryByText('Save')).not.toBeInTheDocument();
    });
    expect(screen.getByTitle('Edit name')).toBeInTheDocument();
  });

  it('shows error message on save failure', async () => {
    mockUpdateUser.mockRejectedValue({
      response: { data: { error: 'Name is required' } },
    });
    const user = userEvent.setup();
    render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);

    await user.click(screen.getByTitle('Edit name'));
    const input = screen.getByDisplayValue('Test User');
    await user.clear(input);
    await user.type(input, 'X');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.getByText('Name is required')).toBeInTheDocument();
    });
  });

  it('saves on Enter key', async () => {
    mockUpdateUser.mockResolvedValue({ ...testUser, name: 'Enter Name' });
    const user = userEvent.setup();
    render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);

    await user.click(screen.getByTitle('Edit name'));
    const input = screen.getByDisplayValue('Test User');
    await user.clear(input);
    await user.type(input, 'Enter Name');
    await user.keyboard('{Enter}');

    expect(mockUpdateUser).toHaveBeenCalledWith({ name: 'Enter Name' });
  });

  it('cancels on Escape key', async () => {
    const user = userEvent.setup();
    render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);

    await user.click(screen.getByTitle('Edit name'));
    await user.keyboard('{Escape}');

    expect(screen.getByText('Test User')).toBeInTheDocument();
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });

  it('disables Save button when input is empty', async () => {
    const user = userEvent.setup();
    render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);

    await user.click(screen.getByTitle('Edit name'));
    const input = screen.getByDisplayValue('Test User');
    await user.clear(input);

    expect(screen.getByText('Save')).toBeDisabled();
  });
});
