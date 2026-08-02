import { useState, useCallback } from 'react';

/** The one failure message both restore entry points show. */
export const RESTORE_FAILURE_MESSAGE = 'Failed to restore this version.';

/**
 * The confirm-restore-then-navigate flow, shared by both entry points
 * (feature 042, FR-013).
 *
 * Two hand-rolled copies used to implement it: the version-history header in
 * `EditorView` and the row menu in `HierarchicalVersionList`. They agreed on
 * everything a user can see — the dialog copy, the busy state, the failure
 * text, navigating to the live document on success — and differed only in
 * incidental structure, which is exactly the shape that drifts.
 *
 * ── THE TARGET IS A PARAMETER, DELIBERATELY ─────────────────────────────────
 * The two sites resolve WHAT to restore differently, and that difference is
 * semantic (contract C7):
 *  - the header restores the LIVE selection, so a mid-flight reconciliation
 *    (feature 041) correctly retargets it to the post-split version id;
 *  - the row menu restores the item CAPTURED when its dialog opened, so a
 *    background history refresh cannot make the confirm act on a different row.
 * Resolving the target inside this hook would silently change one of them. So
 * `open(target)` takes it, and the hook only remembers what it was given.
 *
 * Failure handling matches both originals: a `false` result (the hook's own
 * signalled failure) and a thrown error both leave the dialog OPEN carrying an
 * error, so the user can retry or cancel rather than having their intent
 * silently dropped.
 *
 * @param {function(string): Promise<boolean>} restoreVersion - performs the
 *   restore; resolves truthy on success. Refreshing history afterwards is its
 *   job, not this hook's.
 * @param {object} [opts]
 * @param {function(): void} [opts.onSuccess] - run after a successful restore,
 *   once the dialog has closed (both sites navigate to the live document).
 */
export function useRestoreFlow(restoreVersion, { onSuccess } = {}) {
  // null = closed. Otherwise { target, busy, error }.
  const [state, setState] = useState(null);

  const open = useCallback((target) => {
    setState({ target, busy: false, error: null });
  }, []);

  const cancel = useCallback(() => setState(null), []);

  const confirm = useCallback(async () => {
    // The target is whatever `open` was given — never re-resolved here.
    const target = state?.target;
    if (!target) return;
    setState((prev) => (prev ? { ...prev, busy: true, error: null } : prev));

    try {
      const success = await restoreVersion(target.id);
      if (success) {
        setState(null);
        onSuccess?.();
      } else {
        setState((prev) => (prev ? { ...prev, busy: false, error: RESTORE_FAILURE_MESSAGE } : prev));
      }
    } catch (err) {
      setState((prev) => (
        prev ? { ...prev, busy: false, error: err?.message || RESTORE_FAILURE_MESSAGE } : prev
      ));
    }
  }, [state, restoreVersion, onSuccess]);

  return {
    isOpen: !!state,
    target: state?.target ?? null,
    busy: !!state?.busy,
    error: state?.error ?? null,
    open,
    confirm,
    cancel,
  };
}

export default useRestoreFlow;
