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
 *  - the header restores the LIVE selection AT CONFIRM TIME, so a mid-dialog
 *    reconciliation (feature 041's 10s refresh) correctly retargets it to the
 *    post-split version id — the header site calls `confirmWith(selection)`
 *    from a per-render closure, and a selection reconciled to null makes the
 *    confirm a no-op (dialog stays open), exactly the pre-042 behavior;
 *  - the row menu restores the item CAPTURED when its dialog opened (`open`
 *    remembers it; plain `confirm()` uses it), so a background history refresh
 *    cannot make the confirm act on a different row.
 * Resolving the target inside this hook would silently change one of them
 * (042's review caught the header briefly moving onto captured-at-open
 * semantics — F1, HIGH; `confirmWith` is the fix).
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

  const run = useCallback(async (target) => {
    // A missing target is a no-op with the dialog left open: the header hits
    // this when 041's reconciliation nulled the selection mid-dialog.
    if (!target || !state) return;
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

  // Row-menu semantics: restore the target captured when the dialog opened.
  const confirm = useCallback(() => run(state?.target), [run, state]);

  // Header semantics (C7): the caller supplies the LIVE target at confirm time.
  const confirmWith = useCallback((liveTarget) => run(liveTarget), [run]);

  return {
    isOpen: !!state,
    target: state?.target ?? null,
    busy: !!state?.busy,
    error: state?.error ?? null,
    open,
    confirm,
    confirmWith,
    cancel,
  };
}

export default useRestoreFlow;
