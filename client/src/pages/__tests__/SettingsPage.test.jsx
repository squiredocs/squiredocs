/**
 * SettingsPage Tests
 *
 * Tests the editable name field on the Settings page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

describe('SettingsPage — instance-specific content (feature 058)', () => {
  const usage = { allowed: true, creditCents: 1000, usedCents: 100, remainingCents: 900, extraCreditCents: 0 };

  beforeEach(() => {
    vi.clearAllMocks();
    delete window.__SQUIRE_INSTANCE__;
  });

  function withUsage(u) {
    mockApi.get.mockImplementation((url) => (url === '/api/usage'
      ? Promise.resolve({ data: u })
      : Promise.reject(new Error('not available'))));
  }

  it('shows and copies the MCP URL as this origin + /mcp', () => {
    // The shared test setup replaces window.location with a plain object.
    const savedOrigin = window.location.origin;
    window.location.origin = 'http://localhost:3910';
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);
      expect(screen.getByText('http://localhost:3910/mcp')).toBeInTheDocument();
      expect(screen.queryByText('https://squiredocs.com/mcp')).toBeNull();
      fireEvent.click(screen.getByText('Copy'));
      expect(writeText).toHaveBeenCalledWith('http://localhost:3910/mcp');
    } finally {
      window.location.origin = savedOrigin;
    }
  });

  it('hides the usage meter and beta note when not hosted', async () => {
    withUsage(usage);
    render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/usage'));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('AI Usage')).toBeNull();
    expect(screen.queryByText(/public beta/)).toBeNull();
  });

  it('hides them when hosted but usage is notApplicable', async () => {
    window.__SQUIRE_INSTANCE__ = { hosted: true };
    withUsage({ ...usage, notApplicable: true });
    render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/usage'));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('AI Usage')).toBeNull();
  });

  it('shows them when hosted', async () => {
    window.__SQUIRE_INSTANCE__ = { hosted: true };
    withUsage(usage);
    render(<SettingsPage onNavigateHome={() => {}} user={testUser} />);
    expect(await screen.findByText('AI Usage')).toBeInTheDocument();
    expect(screen.getByText(/public beta/)).toBeInTheDocument();
  });
});
