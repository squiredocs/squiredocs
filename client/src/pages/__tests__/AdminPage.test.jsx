/**
 * AdminPage tests — feature 034 (T012).
 *
 * Minimal by design (the backend suites carry the weight): the admin user list
 * must show the signup/last-login origin columns, and an account created before
 * the feature must render the table's `—` placeholder rather than blowing up on
 * null (US1 acceptance 4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AdminPage from '../AdminPage';

const captured = {
  id: 'user-captured',
  name: 'Captured User',
  email: 'captured@example.com',
  picture: null,
  isAdmin: false,
  emailEnabled: false,
  welcomeEmailSentAt: null,
  aiCreditCents: 1000,
  createdAt: '2026-07-20T10:00:00.000Z',
  lastLoginAt: '2026-07-25T10:00:00.000Z',
  signupIp: '203.0.113.7',
  signupUserAgent: 'Mozilla/5.0 (Signup Agent)',
  lastLoginIp: '198.51.100.9',
  lastLoginUserAgent: 'Mozilla/5.0 (Latest Agent)',
  docCount: 3,
  aiUsedCents: 0,
  aiExtraCreditCents: 0,
  aiRemainingCents: 1000,
};

const preFeature = {
  ...captured,
  id: 'user-prefeature',
  name: 'Pre-feature User',
  email: 'prefeature@example.com',
  signupIp: null,
  signupUserAgent: null,
  lastLoginIp: null,
  lastLoginUserAgent: null,
};

const mockGet = vi.fn();
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    api: {
      get: (...args) => mockGet(...args),
      put: vi.fn(),
      post: vi.fn(),
    },
    logout: vi.fn(),
  }),
}));

vi.mock('../../components/Logo', () => ({ default: () => <div data-testid="logo" /> }));
vi.mock('../../components/UserProfileBadge', () => ({ default: () => <div data-testid="badge" /> }));
vi.mock('../../components/ViewToggleButton', () => ({ default: () => <div data-testid="view-toggle" /> }));
vi.mock('../../components/Avatar', () => ({ default: () => <div data-testid="avatar" /> }));

describe('AdminPage — sign-in origin columns (feature 034)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockImplementation((url) => {
      if (url === '/api/admin/users') {
        return Promise.resolve({ data: { users: [captured, preFeature] } });
      }
      return Promise.reject(new Error('not available'));
    });
  });

  const renderPage = () =>
    render(<AdminPage onNavigateHome={() => {}} user={{ name: 'Admin', email: 'admin@example.com' }} />);

  it('renders the two new column headers', async () => {
    renderPage();
    expect(await screen.findByText('Signup IP')).toBeInTheDocument();
    expect(screen.getByText('Login IP')).toBeInTheDocument();
  });

  it('shows both captured IPs for an account with capture data', async () => {
    renderPage();
    expect(await screen.findByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('198.51.100.9')).toBeInTheDocument();
  });

  it('exposes the user-agent as the cell title (hover fingerprint)', async () => {
    renderPage();
    const signupCell = await screen.findByTitle('Mozilla/5.0 (Signup Agent)');
    expect(signupCell).toHaveTextContent('203.0.113.7');
    expect(screen.getByTitle('Mozilla/5.0 (Latest Agent)')).toHaveTextContent('198.51.100.9');
  });

  it('renders the placeholder for a pre-feature account without erroring', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('prefeature@example.com')).toBeInTheDocument());

    // Both origin cells of the pre-feature row fall back to the table's
    // em-dash placeholder, and the title explains the absence.
    const emptyCells = screen.getAllByTitle('No user-agent recorded');
    expect(emptyCells).toHaveLength(2);
    emptyCells.forEach((cell) => expect(cell).toHaveTextContent('—'));
  });
});
