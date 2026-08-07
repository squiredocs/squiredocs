/**
 * MoveToSpaceDialog — create-then-move (feature 053 follow-up, Sam 2026-08-07).
 *
 * The dialog offers "+ New space…" so a document can be added to a space that
 * does not exist yet: creating from here immediately moves the document into
 * the new space — that is what opening the dialog asked for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MoveToSpaceDialog from '../MoveToSpaceDialog';

const mockGet = vi.fn();
const mockPut = vi.fn();
const mockPost = vi.fn();

vi.mock('../../contexts/AuthContext', () => {
  const api = {
    get: (...args) => mockGet(...args),
    put: (...args) => mockPut(...args),
    post: (...args) => mockPost(...args),
    delete: vi.fn(),
  };
  return { useAuth: () => ({ api, user: { id: 'me' } }) };
});

describe('MoveToSpaceDialog — create a space from the dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: { spaces: [] } });
    mockPut.mockResolvedValue({ data: { docId: 'doc-1', spaceId: 'space-new', spaceName: 'Growth' } });
    mockPost.mockResolvedValue({
      data: { space: { id: 'space-new', name: 'Growth', role: 'owner', memberCount: 1 } },
    });
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

  it('offers "+ New space…" even when the user has no valid target spaces', async () => {
    renderDialog();
    expect(await screen.findByText('You are not an editor or owner of any space yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ New space…' })).toBeInTheDocument();
  });

  it('creating from the dialog moves the document into the new space', async () => {
    const onMoved = vi.fn();
    const onClose = vi.fn();
    renderDialog({ onMoved, onClose });

    await userEvent.click(await screen.findByRole('button', { name: '+ New space…' }));
    await userEvent.type(await screen.findByLabelText('Name'), 'Growth');
    await userEvent.click(screen.getByRole('button', { name: 'Create space' }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/spaces', { name: 'Growth' }));
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/api/docs/doc-1/space', { spaceId: 'space-new' })
    );
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});
