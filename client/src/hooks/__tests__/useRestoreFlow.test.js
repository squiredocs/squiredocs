import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRestoreFlow, RESTORE_FAILURE_MESSAGE } from '../useRestoreFlow';

/**
 * Contract C7 pins (042 review, F1 HIGH): the two restore entry points resolve
 * their target differently and the hook must support BOTH without collapsing
 * them:
 *  - row menu: `confirm()` restores the target captured at `open`;
 *  - header: `confirmWith(live)` restores the LIVE target supplied at confirm
 *    time, and a null live target (selection reconciled away mid-dialog) is a
 *    no-op that leaves the dialog open.
 */
describe('useRestoreFlow C7 target semantics', () => {
  it('confirm() restores the target captured at open (row-menu semantics)', async () => {
    const restoreVersion = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useRestoreFlow(restoreVersion));

    act(() => result.current.open({ id: '42' }));
    await act(() => result.current.confirm());

    expect(restoreVersion).toHaveBeenCalledTimes(1);
    expect(restoreVersion).toHaveBeenCalledWith('42');
    expect(result.current.isOpen).toBe(false);
  });

  it('confirmWith(live) restores the live target, not the one captured at open (header semantics)', async () => {
    const restoreVersion = vi.fn().mockResolvedValue(true);
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useRestoreFlow(restoreVersion, { onSuccess }));

    // Dialog opened on version 42; a background refresh re-split the history
    // and the live selection now points at version 45.
    act(() => result.current.open({ id: '42' }));
    await act(() => result.current.confirmWith({ id: '45' }));

    expect(restoreVersion).toHaveBeenCalledTimes(1);
    expect(restoreVersion).toHaveBeenCalledWith('45');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(result.current.isOpen).toBe(false);
  });

  it('confirmWith(null) is a no-op that leaves the dialog open (selection reconciled away)', async () => {
    const restoreVersion = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useRestoreFlow(restoreVersion));

    act(() => result.current.open({ id: '42' }));
    await act(() => result.current.confirmWith(null));

    expect(restoreVersion).not.toHaveBeenCalled();
    expect(result.current.isOpen).toBe(true);
    expect(result.current.busy).toBe(false);
  });

  it('a failed restore leaves the dialog open with the shared failure message', async () => {
    const restoreVersion = vi.fn().mockResolvedValue(false);
    const { result } = renderHook(() => useRestoreFlow(restoreVersion));

    act(() => result.current.open({ id: '42' }));
    await act(() => result.current.confirm());

    expect(result.current.isOpen).toBe(true);
    expect(result.current.error).toBe(RESTORE_FAILURE_MESSAGE);
  });
});
