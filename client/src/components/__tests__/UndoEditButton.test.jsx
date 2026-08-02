import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';
import AiChatMessages from '../AiChatMessages';

/**
 * Feature 040 — FR-017/FR-018, SC-010/SC-012: the Undo button never offers to
 * undo something it would misreport.
 *
 * `POST /api/docs/:docId/undo` selects the acting identity's most-recent
 * record (LIFO) and uses `toolCallId` ONLY to stamp the "Reverted" marker.
 * Once a web-UI restore is recorded under the same identity (FR-001), an
 * unguarded button on an assistant modify card would invert the RESTORE and
 * mark the MODIFY "Reverted" — a false statement to the user.
 *
 * The guard compares this part's own `editRange.clockStart` with the target
 * `/undo-status` reports, and offers the control only on a match. Crucially it
 * FAILS OPEN when either value is unknown (D15): a fail-closed guard would
 * silently strip a working Undo button from every pre-existing chat card.
 *
 * Case (a) is asserted at the level of "no request is issued", so the test
 * proves the LIE is impossible — not merely that a DOM node is missing.
 */

const mockGet = vi.fn();
const mockPost = vi.fn();
// `api` must be a STABLE reference — components hold it in useCallback deps.
const mockApi = { get: mockGet, post: mockPost };
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ api: mockApi }),
}));
vi.mock('../../contexts/AiChatContext', () => ({
  useAiChat: () => ({ currentChatId: 'chat-1' }),
}));

const DOC = 'doc-123';
const MY_CLOCK = 42;

/**
 * One completed assistant modify card.
 * `pending: true` models the `editRangePending` result (durability wait timed
 * out), where the part carries NO editRange at all.
 */
function renderModify({ editClockStart = MY_CLOCK, reverted = false, pending = false } = {}) {
  const output = {
    changed: true,
    diff: {
      lines: [' context', '-removed row', '+added row'],
      hunkStarts: [{ index: 0, oldStart: 1, newStart: 1 }],
    },
    ...(pending
      ? { editRangePending: true }
      : { editRange: { clockStart: editClockStart, clockEnd: editClockStart } }),
  };
  const messages = [{
    id: 'm1',
    role: 'assistant',
    parts: [{
      type: 'tool-modify',
      toolName: 'modify',
      toolCallId: 'tc-1',
      state: 'output-available',
      input: { docGuid: DOC },
      output,
      ...(reverted ? { reverted: true } : {}),
    }],
  }];
  return render(<AiChatMessages messages={messages} status="ready" />);
}

/** `/undo-status` response builder. */
const status = (body) => ({ data: body });

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('040 T047: UndoEditButton offer guard (FR-017/FR-018)', () => {
  it('(a) hides the control when a RESTORE is the next undo target — and no click path can POST /undo for this part', async () => {
    // A restore landed after this modify, so the next target is NOT this card.
    mockGet.mockResolvedValue(status({
      canUndo: true, canRedo: false, nextUndo: { editClockStart: 99 },
    }));

    renderModify({ editClockStart: MY_CLOCK });

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(`/api/docs/${DOC}/undo-status`));

    // No control is offered ...
    expect(screen.queryByRole('button', { name: 'Undo edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Redo edit' })).toBeNull();

    // ... and therefore nothing can issue the request that would stamp
    // "Reverted" on this modify. THIS is the assertion that matters: the lie
    // is unreachable, not merely invisible.
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('(b) offers the control exactly as before when THIS modify is the next undo target', async () => {
    mockGet.mockResolvedValue(status({
      canUndo: true, canRedo: false, nextUndo: { editClockStart: MY_CLOCK },
    }));

    renderModify({ editClockStart: MY_CLOCK });

    const btn = await screen.findByRole('button', { name: 'Undo edit' });
    expect(btn).toBeInTheDocument();

    mockPost.mockResolvedValue({ data: { undone: true } });
    fireEvent.click(btn);

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      `/api/docs/${DOC}/undo`,
      { chatId: 'chat-1', toolCallId: 'tc-1' },
    ));
  });

  it('(d) an undone card whose record is the next REDO target offers Redo — the same rule governs both directions', async () => {
    // D14: editClockStart is the record's IMMUTABLE identity, so it still
    // matches after the undo — which is exactly why FR-016 reports it rather
    // than the rewritable undo/redo target range.
    mockGet.mockResolvedValue(status({
      canUndo: false, canRedo: true, nextRedo: { editClockStart: MY_CLOCK },
    }));

    renderModify({ editClockStart: MY_CLOCK, reverted: true });

    expect(await screen.findByRole('button', { name: 'Redo edit' })).toBeInTheDocument();
    // The historical marker is unaffected by the guard.
    expect(screen.getByText('Reverted')).toBeInTheDocument();
  });

  it('(d2) hides Redo when a DIFFERENT record is the next redo target, but keeps the "Reverted" label', async () => {
    mockGet.mockResolvedValue(status({
      canUndo: false, canRedo: true, nextRedo: { editClockStart: 99 },
    }));

    renderModify({ editClockStart: MY_CLOCK, reverted: true });

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Redo edit' })).toBeNull();
    // FR-018 governs the ACTION, not the historical marker: this edit really
    // was reverted, so saying so is honest.
    expect(screen.getByText('Reverted')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('(e1) FAILS OPEN when the server omits nextUndo (older server or the legacy fallback)', async () => {
    mockGet.mockResolvedValue(status({ canUndo: true, canRedo: false }));

    renderModify({ editClockStart: MY_CLOCK });

    // Never fail-blank: the control degrades to today's behaviour.
    expect(await screen.findByRole('button', { name: 'Undo edit' })).toBeInTheDocument();
  });

  it('(e2) FAILS OPEN when the part has no editRange (editRangePending — durability wait timed out)', async () => {
    mockGet.mockResolvedValue(status({
      canUndo: true, canRedo: false, nextUndo: { editClockStart: 99 },
    }));

    renderModify({ pending: true });

    expect(await screen.findByRole('button', { name: 'Undo edit' })).toBeInTheDocument();
    // NOTE: this is the N2 window the client cannot close — it has no way to
    // identify the part. It is closed SERVER-SIDE by FR-019: the endpoint
    // performs the undo but refuses to stamp "Reverted" on a part it cannot
    // confirm was the record acted on. See server/undo/reverted-flag.js.
  });

  it('(N3) poll staleness: a status fetched BEFORE a restore still offers the button, and the client re-polls after the click', async () => {
    // The component polls every 30s and nothing tells it that a restore
    // happened in the version-history panel, so for up to 30s it holds a
    // status that still names THIS part as the next undo target.
    mockGet.mockResolvedValueOnce(status({
      canUndo: true, canRedo: false, nextUndo: { editClockStart: MY_CLOCK },
    }));

    renderModify({ editClockStart: MY_CLOCK });
    const btn = await screen.findByRole('button', { name: 'Undo edit' });

    // The restore has landed server-side by now. The client cannot know.
    // Pinned behaviour: it DOES issue the POST — D15 mandates acting on the
    // data it has, and it has no fresher data.
    mockPost.mockResolvedValue({ data: { undone: true } });
    // The post-action re-poll sees the world as it now really is.
    mockGet.mockResolvedValue(status({
      canUndo: true, canRedo: false, nextUndo: { editClockStart: 99 },
    }));

    fireEvent.click(btn);

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      `/api/docs/${DOC}/undo`,
      { chatId: 'chat-1', toolCallId: 'tc-1' },
    ));

    // Correctness here is carried SERVER-SIDE (FR-019): the undo happens, but
    // the server refuses to mark this modify "Reverted" because it was not
    // the record inverted. The client's job is to self-correct, which it does
    // by re-fetching status in its `finally`.
    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(1));
  });

  it('a status request failure still fails safe (both-false) without crashing', async () => {
    mockGet.mockRejectedValue(new Error('network'));

    renderModify({ editClockStart: MY_CLOCK });

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Undo edit' })).toBeNull();
  });
});
