/**
 * ShareDialog — the read-only space-grant line (feature 053, FR-043).
 *
 * Why this exists: with spaces, a document can have an audience nobody added
 * from this dialog. The line says so. It must never look editable — space
 * membership is managed on the space page, and a remove button here would
 * promise something this dialog cannot do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ShareDialog from '../ShareDialog';

const mockGet = vi.fn();

vi.mock('../../contexts/AuthContext', () => {
  const api = {
    get: (...args) => mockGet(...args),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
  return { useAuth: () => ({ api, user: { id: 'me', emailEnabled: true } }) };
});

vi.mock('../Avatar', () => ({ default: () => <div data-testid="avatar" /> }));

const baseShares = {
  users: [{ id: 'me', email: 'me@example.com', name: 'Me', picture: null, role: 'owner' }],
  invites: [],
  currentUserRole: 'owner',
};

describe('ShareDialog — space grant line', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderDialog = () =>
    render(<ShareDialog docId="doc-1" docTitle="Migration plan" isOpen onClose={() => {}} />);

  it('shows the space and its member count when the document lives in one', async () => {
    mockGet.mockResolvedValue({
      data: { ...baseShares, spaceGrant: { id: 'space-1', name: 'Platform', role: 'editor', memberCount: 12 } },
    });
    renderDialog();

    await waitFor(() => expect(screen.getByText('Platform')).toBeInTheDocument());
    expect(screen.getByText(/everyone in that space can\s+reach it/i)).toBeInTheDocument();
    expect(screen.getByText(/12\s+members/)).toBeInTheDocument();
  });

  it('says "member" rather than "members" for a space of one', async () => {
    mockGet.mockResolvedValue({
      data: { ...baseShares, spaceGrant: { id: 'space-1', name: 'Solo', role: 'owner', memberCount: 1 } },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText(/1\s+member\)/)).toBeInTheDocument());
  });

  it('shows nothing for a personal document', async () => {
    mockGet.mockResolvedValue({ data: { ...baseShares, spaceGrant: null } });
    renderDialog();

    await waitFor(() => expect(screen.getByText('People with access')).toBeInTheDocument());
    expect(document.querySelector('.share-space-grant')).toBeNull();
  });

  it('is never editable — no control inside the line', async () => {
    mockGet.mockResolvedValue({
      data: { ...baseShares, spaceGrant: { id: 'space-1', name: 'Platform', role: 'editor', memberCount: 12 } },
    });
    renderDialog();

    await waitFor(() => expect(document.querySelector('.share-space-grant')).not.toBeNull());
    const line = document.querySelector('.share-space-grant');
    expect(line.querySelectorAll('button, select, input')).toHaveLength(0);
  });

  it('tolerates an older response with no spaceGrant field at all', async () => {
    mockGet.mockResolvedValue({ data: baseShares });
    renderDialog();
    await waitFor(() => expect(screen.getByText('People with access')).toBeInTheDocument());
    expect(document.querySelector('.share-space-grant')).toBeNull();
  });
});
