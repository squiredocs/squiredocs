/**
 * AdminPage tests — feature 034 (T012).
 *
 * Minimal by design (the backend suites carry the weight): the admin user list
 * must show the captured sign-in origin, and an account created before
 * the feature must render the table's `—` placeholder rather than blowing up on
 * null (US1 acceptance 4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
const mockPatch = vi.fn();
// `api` is built ONCE, inside the factory, and handed back by identity on every
// call. AdminPage's boot effect is keyed on it (`useEffect(..., [api])`), so a
// fresh object per render — as this mock originally built — makes each
// fetch-driven state update look like a new `api` and re-fires the effect: the
// page re-fetches forever. Invisible to a test that asserts and exits at once;
// a runaway loop (worker OOM) for one that waits on an element that never
// appears. The method bodies stay lazy so the vi.mock hoist doesn't trip on the
// mockGet/mockPatch declarations below it.
vi.mock('../../contexts/AuthContext', () => {
  const api = {
    get: (...args) => mockGet(...args),
    put: vi.fn(),
    post: vi.fn(),
    patch: (...args) => mockPatch(...args),
  };
  return { useAuth: () => ({ api, logout: vi.fn() }) };
});

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

/**
 * Feature 035 — the per-user "Assistant model" picker in the expanded row.
 *
 * The options come from the SAME shared-model payload the shared-default picker
 * uses (there is no second, hand-listed model set to drift), and a stored value
 * that is no longer eligible renders as the "unavailable — using X" option
 * rather than misrepresenting the user as on Default (FR-010).
 */
describe('AdminPage — per-user chat model override (feature 035)', () => {
  const sharedModelPayload = {
    modelKey: 'claude-sonnet',
    effectiveModelKey: 'claude-sonnet',
    deploymentDefaultKey: 'claude-opus',
    models: [
      { key: 'claude-haiku', label: 'Claude Haiku 4.5', provider: 'anthropic' },
      { key: 'claude-sonnet', label: 'Claude Sonnet 4.6', provider: 'anthropic' },
      { key: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google' },
    ],
    providers: [
      { id: 'anthropic', label: 'Anthropic' },
      { id: 'google', label: 'Google' },
    ],
  };

  const plain = { ...captured, id: 'user-plain', email: 'plain@example.com', chatModelOverride: null };
  const pinned = { ...captured, id: 'user-pinned', email: 'pinned@example.com', chatModelOverride: 'claude-haiku' };
  const stale = { ...captured, id: 'user-stale', email: 'stale@example.com', chatModelOverride: 'or-glm-4.7' };

  const mockList = (list) => {
    mockGet.mockImplementation((url) => {
      if (url === '/api/admin/users') return Promise.resolve({ data: { users: list } });
      if (url === '/api/admin/settings/shared-model') return Promise.resolve({ data: sharedModelPayload });
      if (url.endsWith('/extra-credits')) return Promise.resolve({ data: { credits: [] } });
      if (url.endsWith('/sharing')) return Promise.resolve({ data: { invites: [], shares: [] } });
      return Promise.reject(new Error('not available'));
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPatch.mockResolvedValue({ data: {} });
  });

  const renderPage = () =>
    render(<AdminPage onNavigateHome={() => {}} user={{ name: 'Admin', email: 'admin@example.com' }} />);

  // Expand the row and return its "Assistant model" <select>.
  const openPicker = async (email) => {
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText(email)).closest('tr');
    await user.click(within(row).getByLabelText(/Expand details/i));
    const section = (await screen.findByText('Assistant model')).closest('.admin-detail-section');
    return { user, select: within(section).getByRole('combobox') };
  };

  it('marks pinned users in the list itself, without expanding the row', async () => {
    mockList([plain, pinned]);
    renderPage();

    // The badge names the model, so an admin scanning the table sees both THAT
    // a user is pinned and to WHAT, with no clicking.
    const pinnedRow = (await screen.findByText('pinned@example.com')).closest('tr');
    expect(within(pinnedRow).getByTitle(/pinned to Claude Haiku 4\.5/i)).toHaveTextContent(
      'Claude Haiku 4.5',
    );

    // ...and an unpinned user carries no badge at all (it must not cost width
    // for the common case).
    const plainRow = screen.getByText('plain@example.com').closest('tr');
    expect(within(plainRow).queryByTitle(/pinned to/i)).toBeNull();
  });

  it('shows Default (<shared effective label>) selected for a user with no override', async () => {
    mockList([plain]);
    const { select } = await openPicker('plain@example.com');

    expect(select.value).toBe('');
    const selected = select.options[select.selectedIndex];
    expect(selected.textContent).toContain('Default');
    expect(selected.textContent).toContain('Claude Sonnet 4.6');
  });

  it('offers exactly the shared-model payload models, grouped by provider, plus Default', async () => {
    mockList([plain]);
    const { select } = await openPicker('plain@example.com');

    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['', 'claude-haiku', 'claude-sonnet', 'gemini-2.5-flash']);

    const groups = Array.from(select.querySelectorAll('optgroup')).map((g) => g.label);
    expect(groups).toEqual(['Anthropic', 'Google']);
  });

  it('shows the pinned model as the selected option', async () => {
    mockList([pinned]);
    const { select } = await openPicker('pinned@example.com');

    expect(select.value).toBe('claude-haiku');
    expect(select.options[select.selectedIndex].textContent).toBe('Claude Haiku 4.5');
  });

  it('FR-010: a stored-but-ineligible override renders as "unavailable — using X", never Default', async () => {
    mockList([stale]);
    const { select } = await openPicker('stale@example.com');

    expect(select.value).toBe('or-glm-4.7');
    const selected = select.options[select.selectedIndex];
    expect(selected.textContent).toContain('or-glm-4.7');
    expect(selected.textContent).toContain('unavailable — using Claude Sonnet 4.6');
    expect(selected.disabled).toBe(true);
    expect(selected.textContent).not.toContain('Default');
  });

  it('choosing a model PATCHes the per-user endpoint with that key', async () => {
    mockList([plain]);
    const { user, select } = await openPicker('plain@example.com');

    await user.selectOptions(select, 'gemini-2.5-flash');

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith(
      '/api/admin/users/user-plain/chat-model',
      { modelKey: 'gemini-2.5-flash' }
    ));
  });

  it('choosing Default PATCHes modelKey: null (clear)', async () => {
    mockList([pinned]);
    const { user, select } = await openPicker('pinned@example.com');

    await user.selectOptions(select, '');

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith(
      '/api/admin/users/user-pinned/chat-model',
      { modelKey: null }
    ));
  });

  it('renders a plain note instead of the picker when the model list is unavailable', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/api/admin/users') return Promise.resolve({ data: { users: [plain] } });
      return Promise.reject(new Error('not available'));
    });
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText('plain@example.com')).closest('tr');
    await user.click(within(row).getByLabelText(/Expand details/i));

    const section = (await screen.findByText('Assistant model')).closest('.admin-detail-section');
    expect(within(section).getByText('Model list unavailable.')).toBeInTheDocument();
    expect(within(section).queryByRole('combobox')).toBeNull();
  });
});
