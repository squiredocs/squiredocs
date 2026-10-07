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

describe('AdminPage — user list sorting', () => {
  // Deliberately adversarial ordering: the API returns them newest-signup
  // first (the old fixed order), which is NOT the recency-of-activity order.
  const dormant = {
    ...captured,
    id: 'user-dormant',
    email: 'dormant@example.com',
    createdAt: '2026-07-28T10:00:00.000Z',
    lastLoginAt: null,
    docCount: 9,
  };
  const stale = {
    ...captured,
    id: 'user-stale',
    email: 'stale@example.com',
    createdAt: '2026-06-01T10:00:00.000Z',
    lastLoginAt: '2026-06-02T10:00:00.000Z',
    docCount: 5,
  };
  const active = {
    ...captured,
    id: 'user-active',
    email: 'active@example.com',
    createdAt: '2026-05-01T10:00:00.000Z',
    lastLoginAt: '2026-07-29T10:00:00.000Z',
    docCount: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockImplementation((url) => {
      if (url === '/api/admin/users') {
        return Promise.resolve({ data: { users: [dormant, stale, active] } });
      }
      return Promise.reject(new Error('not available'));
    });
  });

  const renderPage = () =>
    render(<AdminPage onNavigateHome={() => {}} user={{ name: 'Admin', email: 'admin@example.com' }} />);

  const emailOrder = () =>
    Array.from(document.querySelectorAll('.admin-user-email')).map((el) => el.textContent);

  it('defaults to most recently active first, never-signed-in last', async () => {
    renderPage();
    await screen.findByText('active@example.com');

    expect(emailOrder()).toEqual([
      'active@example.com',
      'stale@example.com',
      'dormant@example.com',
    ]);
  });

  it('prefers lastActivityAt over lastLoginAt for recency', async () => {
    // Stale login but a fresh server-derived activity timestamp (e.g. doc
    // edits on a refresh-token session) — must outrank everyone.
    const editing = {
      ...captured,
      id: 'user-editing',
      email: 'editing@example.com',
      createdAt: '2026-04-01T10:00:00.000Z',
      lastLoginAt: '2026-05-01T10:00:00.000Z',
      lastActivityAt: '2026-07-30T10:00:00.000Z',
      docCount: 0,
    };
    mockGet.mockImplementation((url) => {
      if (url === '/api/admin/users') {
        return Promise.resolve({ data: { users: [dormant, stale, active, editing] } });
      }
      return Promise.reject(new Error('not available'));
    });

    renderPage();
    await screen.findByText('editing@example.com');

    expect(emailOrder()).toEqual([
      'editing@example.com',
      'active@example.com',
      'stale@example.com',
      'dormant@example.com',
    ]);
  });

  it('re-orders the list when another sort is chosen', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('active@example.com');

    // Newest signup first — the reverse of activity recency in this fixture.
    await user.selectOptions(screen.getByLabelText('Sort by'), 'newest');
    expect(emailOrder()).toEqual([
      'dormant@example.com',
      'stale@example.com',
      'active@example.com',
    ]);

    await user.selectOptions(screen.getByLabelText('Sort by'), 'docs');
    expect(emailOrder()).toEqual([
      'dormant@example.com',
      'stale@example.com',
      'active@example.com',
    ]);
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

/**
 * Feature 036 — the per-user agent-access, onboarding and activity panels in
 * the expanded row.
 *
 * The value of the panel is that it distinguishes live access from dead access
 * and says honestly what the activity number covers, so those are what the
 * tests pin — along with the isolation guarantee: the adoption fetch is a third
 * independent call, and its failure must not take the neighbouring panels with
 * it (FR-012).
 */
describe('AdminPage — per-user adoption detail (feature 036)', () => {
  const subject = { ...captured, id: 'user-adoption', email: 'adoption@example.com' };

  const adoptionPayload = {
    delegations: [
      {
        id: 'del-1', agentName: 'Claude Code', agentClientId: 'claude-code',
        scopes: ['documents:read', 'documents:write'],
        createdAt: '2026-01-02T00:00:00.000Z', lastUsedAt: '2026-07-20T09:30:00.000Z',
        revokedAt: null, expiresAt: null, state: 'active',
      },
      {
        id: 'del-2', agentName: 'Retired Agent', agentClientId: null,
        scopes: ['documents:read'],
        createdAt: '2026-02-02T00:00:00.000Z', lastUsedAt: null,
        revokedAt: '2026-03-03T00:00:00.000Z', expiresAt: null, state: 'revoked',
      },
    ],
    tokens: [
      {
        id: 'tok-1', name: 'Laptop token', tokenPrefix: 'sk_sqd_aaa', scopes: ['documents:read'],
        createdAt: '2026-04-01T00:00:00.000Z', lastUsedAt: '2026-07-25T08:00:00.000Z',
        revokedAt: null, expiresAt: null, state: 'active', mintedBy: 'interactive',
      },
      {
        id: 'tok-2', name: 'Agent-minted token', tokenPrefix: 'sk_sqd_bbb', scopes: ['documents:write'],
        createdAt: '2026-04-02T00:00:00.000Z', lastUsedAt: null,
        revokedAt: null, expiresAt: '2026-05-01T00:00:00.000Z', state: 'expired', mintedBy: 'agent',
      },
    ],
    onboarding: {
      signupSource: 'agent_oauth',
      createdAt: '2026-01-01T00:00:00.000Z',
      onboardedAt: '2026-01-05T00:00:00.000Z',
      authoredNonWelcomeDoc: true,
      welcomeEmailSentAt: null,
    },
    activity: { count: 42, lastActivityAt: '2026-07-24T12:00:00.000Z' },
  };

  const emptyPayload = {
    delegations: [],
    tokens: [],
    onboarding: {
      signupSource: 'browser', createdAt: '2026-07-01T00:00:00.000Z',
      onboardedAt: null, authoredNonWelcomeDoc: false, welcomeEmailSentAt: null,
    },
    activity: { count: 0, lastActivityAt: null },
  };

  // `adoption` defaults to the rich payload; pass null to make that ONE call
  // fail while the others still resolve.
  const mockWith = (adoption) => {
    mockGet.mockImplementation((url) => {
      if (url === '/api/admin/users') return Promise.resolve({ data: { users: [subject] } });
      if (url === '/api/admin/settings/shared-model') return Promise.reject(new Error('not available'));
      if (url.endsWith('/extra-credits')) return Promise.resolve({ data: { credits: [] } });
      if (url.endsWith('/sharing')) return Promise.resolve({ data: { invites: [], shares: [] } });
      if (url.endsWith('/adoption')) {
        return adoption ? Promise.resolve({ data: adoption }) : Promise.reject(new Error('boom'));
      }
      return Promise.reject(new Error('not available'));
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const expandRow = async () => {
    const user = userEvent.setup();
    render(<AdminPage onNavigateHome={() => {}} user={{ name: 'Admin', email: 'admin@example.com' }} />);
    const row = (await screen.findByText('adoption@example.com')).closest('tr');
    await user.click(within(row).getByLabelText(/Expand details/i));
    return user;
  };

  const sectionFor = async (heading) =>
    (await screen.findByText(heading)).closest('.admin-detail-section');

  it('fetches the adoption detail on expand, not with the user list', async () => {
    mockWith(adoptionPayload);
    render(<AdminPage onNavigateHome={() => {}} user={{ name: 'Admin', email: 'admin@example.com' }} />);
    await screen.findByText('adoption@example.com');

    // The list is loaded; nothing has asked for adoption yet (FR-007).
    expect(mockGet).not.toHaveBeenCalledWith('/api/admin/users/user-adoption/adoption');

    const row = screen.getByText('adoption@example.com').closest('tr');
    await userEvent.setup().click(within(row).getByLabelText(/Expand details/i));

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/admin/users/user-adoption/adoption'));
  });

  it('lists revoked delegations alongside active ones, each state-labelled', async () => {
    mockWith(adoptionPayload);
    await expandRow();
    const section = await sectionFor('Agent access');

    // Lifetime semantics: the dead delegation is present, not filtered out.
    expect(within(section).getByText('Claude Code')).toBeInTheDocument();
    expect(within(section).getByText('Retired Agent')).toBeInTheDocument();

    const activeRow = within(section).getByText('Claude Code').closest('tr');
    expect(within(activeRow).getByText('active')).toBeInTheDocument();
    const revokedRow = within(section).getByText('Retired Agent').closest('tr');
    expect(within(revokedRow).getByText('revoked')).toBeInTheDocument();
  });

  it('shows each token by name and non-secret prefix, with its mint path', async () => {
    mockWith(adoptionPayload);
    await expandRow();
    const section = await sectionFor('Agent access');

    const interactive = within(section).getByText('Laptop token').closest('tr');
    expect(within(interactive).getByText('sk_sqd_aaa')).toBeInTheDocument();
    expect(within(interactive).getByText('Interactively')).toBeInTheDocument();

    const agentMinted = within(section).getByText('Agent-minted token').closest('tr');
    expect(within(agentMinted).getByText('By an agent')).toBeInTheDocument();
    expect(within(agentMinted).getByText('expired')).toBeInTheDocument();
  });

  it('reports the onboarding position, including the signup path', async () => {
    mockWith(adoptionPayload);
    await expandRow();
    const section = await sectionFor('Onboarding');

    expect(within(section).getByText('Agent OAuth')).toBeInTheDocument();
    expect(within(section).getByText('Yes')).toBeInTheDocument();
    expect(within(section).getByText('Not sent')).toBeInTheDocument();
  });

  it('labels the doc predicate for what it is, not as "engaged"', async () => {
    mockWith(adoptionPayload);
    await expandRow();
    const section = await sectionFor('Onboarding');

    // RBD-10: it is weaker than onboardedAt — mere ownership of a second doc.
    expect(within(section).getByText('Owns a doc besides the welcome doc')).toBeInTheDocument();
    expect(within(section).queryByText(/engaged|activated/i)).toBeNull();
  });

  it('labels the activity summary as OAuth-delegated calls and points at token last-used', async () => {
    mockWith(adoptionPayload);
    await expandRow();

    // The heading must not claim to cover all agent traffic: the log records
    // only delegation-authenticated MCP calls. A regression here is silent and
    // misleading, which is exactly why the wording is pinned.
    const section = await sectionFor('Onboarding');
    expect(within(section).getByText('Agent sessions (OAuth-delegated MCP calls)')).toBeInTheDocument();
    expect(within(section).getByText('42')).toBeInTheDocument();
    expect(within(section).getByText(
      'API-token and REST traffic are not logged — see each token’s Last used.',
    )).toBeInTheDocument();
  });

  it('renders plain empty states for a user who never connected anything', async () => {
    mockWith(emptyPayload);
    await expandRow();
    const section = await sectionFor('Agent access');

    expect(within(section).getByText('No agent connections.')).toBeInTheDocument();
    expect(within(section).getByText('No API tokens.')).toBeInTheDocument();

    // Null onboarding fields read as words, not blanks or "Invalid Date".
    const onboarding = await sectionFor('Onboarding');
    expect(within(onboarding).getByText('Not yet')).toBeInTheDocument();
    expect(within(onboarding).getByText('Not sent')).toBeInTheDocument();
    expect(within(onboarding).getByText('No')).toBeInTheDocument();
    expect(within(onboarding).getByText('Browser')).toBeInTheDocument();
  });

  it('a failed adoption fetch degrades to a note and leaves the other panels intact', async () => {
    mockWith(null);
    await expandRow();

    const section = await sectionFor('Agent access');
    expect(within(section).getByText('Couldn’t load agent detail.')).toBeInTheDocument();

    // The neighbouring panels loaded from their own independent calls.
    const sharing = await sectionFor('Sharing activity');
    expect(within(sharing).getByText('No invites sent.')).toBeInTheDocument();
    expect(screen.getByText('No extra credit records.')).toBeInTheDocument();
    expect(screen.getByText('Sign-in origin')).toBeInTheDocument();
  });

  it('renders agent and token names as text, never as markup', async () => {
    const hostile = {
      ...adoptionPayload,
      delegations: [{
        ...adoptionPayload.delegations[0],
        agentName: '<img src=x onerror="alert(1)">',
        agentClientId: '<script>alert(2)</script>',
      }],
      tokens: [{ ...adoptionPayload.tokens[0], name: '<b>bold token</b>' }],
    };
    mockWith(hostile);
    await expandRow();
    const section = await sectionFor('Agent access');

    // Self-reported by the OAuth client (dynamic registration is open), so the
    // values are attacker-controlled: they must survive as literal text.
    expect(within(section).getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(within(section).getByText('<script>alert(2)</script>')).toBeInTheDocument();
    expect(within(section).getByText('<b>bold token</b>')).toBeInTheDocument();
    expect(section.querySelector('img')).toBeNull();
    expect(section.querySelector('script')).toBeNull();
  });

  it('never shows one user’s credentials under another user’s row', async () => {
    const other = { ...captured, id: 'user-other', email: 'other@example.com' };
    let releaseSlowAdoption;
    const slow = new Promise((resolve) => { releaseSlowAdoption = resolve; });

    mockGet.mockImplementation((url) => {
      if (url === '/api/admin/users') return Promise.resolve({ data: { users: [subject, other] } });
      if (url === '/api/admin/settings/shared-model') return Promise.reject(new Error('not available'));
      if (url.endsWith('/extra-credits')) return Promise.resolve({ data: { credits: [] } });
      if (url.endsWith('/sharing')) return Promise.resolve({ data: { invites: [], shares: [] } });
      // The FIRST user expanded answers slowly; the second answers at once.
      if (url === `/api/admin/users/${subject.id}/adoption`) return slow;
      if (url === `/api/admin/users/${other.id}/adoption`) {
        return Promise.resolve({ data: { ...adoptionPayload, delegations: [], tokens: [] } });
      }
      return Promise.reject(new Error('not available'));
    });

    const user = userEvent.setup();
    render(<AdminPage onNavigateHome={() => {}} user={{ name: 'Admin', email: 'admin@example.com' }} />);

    const firstRow = (await screen.findByText('adoption@example.com')).closest('tr');
    await user.click(within(firstRow).getByLabelText(/Expand details/i));
    const secondRow = screen.getByText('other@example.com').closest('tr');
    await user.click(within(secondRow).getByLabelText(/Expand details/i));

    // Now let the first user's response land late. It must be discarded: the
    // open row belongs to someone else, and this is the view an admin uses to
    // decide whether THIS account connected an agent.
    releaseSlowAdoption({ data: adoptionPayload });
    await screen.findByText('Agent access');

    const section = (await screen.findByText('Agent access')).closest('.admin-detail-section');
    expect(within(section).queryByText(adoptionPayload.delegations[0].agentName)).toBeNull();
  });
});

describe('AdminPage — hosted-only controls (feature 058)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.__SQUIRE_INSTANCE__;
    mockGet.mockImplementation((url) => {
      if (url === '/api/admin/users') {
        return Promise.resolve({ data: { users: [captured] } });
      }
      return Promise.reject(new Error('not available'));
    });
  });

  const renderPage = () =>
    render(<AdminPage onNavigateHome={() => {}} user={{ name: 'Admin', email: 'admin@example.com' }} />);

  it('hides the welcome-email button and self-test card when not hosted', async () => {
    renderPage();
    expect(await screen.findByText('IP')).toBeInTheDocument();
    expect(screen.queryByLabelText('Send welcome email')).toBeNull();
    expect(screen.queryByText('Plugin first-run self-test')).toBeNull();
  });

  it('shows them when hosted', async () => {
    window.__SQUIRE_INSTANCE__ = { hosted: true };
    renderPage();
    expect(await screen.findByLabelText('Send welcome email')).toBeInTheDocument();
    expect(screen.getByText('Plugin first-run self-test')).toBeInTheDocument();
  });
});
