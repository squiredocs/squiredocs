/**
 * AdminPage tests — feature 034 (T012).
 *
 * Minimal by design (the backend suites carry the weight): the admin user list
 * must show the captured sign-in origin, and an account created before
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

  it('renders the origin column header', async () => {
    renderPage();
    expect(await screen.findByText('IP')).toBeInTheDocument();
  });

  it('shows the latest address in the list, both on the cell title', async () => {
    renderPage();
    // The narrow list carries the last-login address; the signup one would
    // double the column's width for a value that only matters on inspection.
    expect(await screen.findByText('198.51.100.9')).toBeInTheDocument();

    const cell = screen.getByText('198.51.100.9');
    expect(cell).toHaveAttribute(
      'title',
      'Signup 203.0.113.7 · Mozilla/5.0 (Signup Agent)\n'
        + 'Last login 198.51.100.9 · Mozilla/5.0 (Latest Agent)',
    );
  });

  it('renders the placeholder for a pre-feature account without erroring', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('prefeature@example.com')).toBeInTheDocument());

    // The pre-feature row's origin cell falls back to the table's em-dash
    // placeholder, and its title explains both absences.
    // getByTitle's default normalizer collapses the newline between the two
    // origin lines, so keep the raw string.
    const emptyCell = screen.getByTitle(
      'Signup — · no user-agent recorded\nLast login — · no user-agent recorded',
      { normalizer: (s) => s },
    );
    expect(emptyCell).toHaveTextContent('—');
  });
});

describe('AdminPage — shared model picker prices', () => {
  const sharedModel = {
    modelKey: null,
    effectiveModelKey: 'claude-opus-5',
    deploymentDefaultKey: 'claude-opus-5',
    providers: [{ id: 'anthropic', label: 'Anthropic' }],
    models: [
      // pricing is cents per 1M tokens, as the registry stores it.
      { key: 'claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic', pricing: { input: 500, output: 2500 } },
      { key: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'anthropic', pricing: { input: 30, output: 250 } },
      { key: 'free-model', label: 'Free Model', provider: 'anthropic', pricing: { input: 0, output: 0 } },
      { key: 'no-price', label: 'No Price', provider: 'anthropic' },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockImplementation((url) => {
      if (url === '/api/admin/users') return Promise.resolve({ data: { users: [captured] } });
      if (url === '/api/admin/settings/shared-model') return Promise.resolve({ data: sharedModel });
      return Promise.reject(new Error('not available'));
    });
  });

  const renderPage = () =>
    render(<AdminPage onNavigateHome={() => {}} user={{ name: 'Admin', email: 'admin@example.com' }} />);

  it('shows each option price in dollars per 1M tokens', async () => {
    renderPage();
    expect(await screen.findByText('Claude Opus 5 — $5/$25 per 1M')).toBeInTheDocument();
    // Sub-dollar prices keep their cents.
    expect(screen.getByText('Gemini 2.5 Flash — $0.30/$2.50 per 1M')).toBeInTheDocument();
  });

  it('renders zero and missing pricing without $NaN or $0/$0', async () => {
    renderPage();
    expect(await screen.findByText('Free Model — free')).toBeInTheDocument();
    expect(screen.getByText('No Price')).toBeInTheDocument();
  });

  it('keeps the deployment-default label price-free', async () => {
    renderPage();
    expect(await screen.findByText('Deployment default (Claude Opus 5)')).toBeInTheDocument();
  });
});
