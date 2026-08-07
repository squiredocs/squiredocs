/**
 * MoveToSpaceDialog — feature 053 (FR-041).
 *
 * The two claims that matter: only spaces the caller can actually move INTO are
 * offered, and a refusal shows the SERVER'S reason rather than a generic
 * failure — the three refusal reasons are genuinely different and only the
 * server knows which applies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MoveToSpaceDialog from '../MoveToSpaceDialog';

const mockGet = vi.fn();
const mockPut = vi.fn();

vi.mock('../../contexts/AuthContext', () => {
  const api = {
    get: (...args) => mockGet(...args),
    put: (...args) => mockPut(...args),
    post: vi.fn(),
    delete: vi.fn(),
  };
  return { useAuth: () => ({ api, user: { id: 'me' } }) };
});

const SPACES = [
  { id: 'space-own', name: 'Platform', role: 'owner', memberCount: 12 },
  { id: 'space-edit', name: 'Design', role: 'editor', memberCount: 3 },
  { id: 'space-view', name: 'Legal', role: 'viewer', memberCount: 1 },
];

describe('MoveToSpaceDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: { spaces: SPACES } });
    mockPut.mockResolvedValue({ data: { docId: 'doc-1', spaceId: 'space-own', spaceName: 'Platform' } });
  });

  const renderDialog = (props = {}) =>
    render(
      <MoveToSpaceDialog
        docId="doc-1"
        docTitle="Migration plan"
        currentSpaceId={null}
        isOpen
        onClose={props.onClose || (() => {})}
        onMoved={props.onMoved || (() => {})}
        {...props}
      />
    );

  it('renders nothing when closed', () => {
    const { container } = render(
      <MoveToSpaceDialog docId="doc-1" isOpen={false} onClose={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('offers only spaces where the caller is an editor or owner', async () => {
    renderDialog();
    expect(await screen.findByText('Platform')).toBeInTheDocument();
    expect(screen.getByText('Design')).toBeInTheDocument();
    // A viewer member cannot move a document in, so the space is not offered.
    expect(screen.queryByText('Legal')).not.toBeInTheDocument();
  });

  it('always offers the personal area', async () => {
    renderDialog({ currentSpaceId: 'space-own' });
    expect(await screen.findByText('My Docs (personal)')).toBeInTheDocument();
  });

  it('marks the current home and disables choosing it again', async () => {
    renderDialog({ currentSpaceId: 'space-own' });
    const current = await screen.findByText('Platform');
    expect(current.closest('button')).toBeDisabled();
    expect(screen.getAllByText('Current')).toHaveLength(1);
  });

  it('PUTs the chosen space and reports the move', async () => {
    const onMoved = vi.fn();
    const onClose = vi.fn();
    renderDialog({ onMoved, onClose });

    await userEvent.click(await screen.findByText('Platform'));

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/api/docs/doc-1/space', { spaceId: 'space-own' }));
    expect(onMoved).toHaveBeenCalledWith({ docId: 'doc-1', spaceId: 'space-own', spaceName: 'Platform' });
    expect(onClose).toHaveBeenCalled();
  });

  it('moves to personal with a null space id', async () => {
    renderDialog({ currentSpaceId: 'space-own' });
    await userEvent.click(await screen.findByText('My Docs (personal)'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/api/docs/doc-1/space', { spaceId: null }));
  });

  it("surfaces the server's refusal verbatim, not a generic error", async () => {
    mockPut.mockRejectedValue({
      response: { data: { error: 'You can only move this document out to your personal area' } },
    });
    const onClose = vi.fn();
    renderDialog({ onClose });

    await userEvent.click(await screen.findByText('Platform'));

    expect(
      await screen.findByText('You can only move this document out to your personal area')
    ).toBeInTheDocument();
    // The dialog stays open so the reason is readable and the user can retry.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('explains the empty case rather than showing a bare list', async () => {
    mockGet.mockResolvedValue({ data: { spaces: [{ id: 's', name: 'Legal', role: 'viewer', memberCount: 1 }] } });
    renderDialog();
    expect(await screen.findByText(/not an editor or owner of any space/i)).toBeInTheDocument();
  });
});
