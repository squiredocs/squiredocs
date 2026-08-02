import { createContext, useContext } from 'react';

/**
 * The version-history data and callbacks that `VersionHistoryPanel` used to
 * forward, unchanged, to `HierarchicalVersionList`.
 *
 * Fourteen of the panel's declared props existed only to be handed straight
 * down: it read none of them and transformed none of them. Every new piece of
 * data the list needed meant editing three files, and the prop lists drifted
 * (`versionContent` was still being passed to a component that had stopped
 * declaring it). Feature 042 (FR-012, DEC-3) moved the pass-throughs into
 * context and left the panel's OWN chrome — `isOpen`, `onClose`, `totalEdits`,
 * `showDiffHighlights`, `onToggleDiffHighlights`, the local `filter`, and
 * `isLoading` — as ordinary props and state.
 *
 * ── PROPS WIN OVER CONTEXT (the load-bearing part) ──────────────────────────
 * `useVersionHistoryValues` merges explicit props OVER the context value. That
 * keeps `HierarchicalVersionList` mountable directly with props and no provider
 * — which the existing 574-line `HierarchicalVersionList.test.jsx` does
 * throughout, and which FR-001 forbids modifying. It is also the friendlier
 * shape generally: a caller can still override one value without a provider.
 *
 * @param {object} props - the component's own props (may be sparse)
 * @param {object} [defaults] - fallbacks for keys absent from BOTH props and
 *   context, so the component's default-parameter values survive the merge
 */
const VersionHistoryContext = createContext(null);

/** Keys the context carries. Anything else stays an ordinary prop. */
const CONTEXT_KEYS = [
  'selection',
  'onSelectVersion',
  'onSelectUpdate',
  'onLoadUpdates',
  'versionUpdates',
  'versionUpdatesMeta',
  'loadingVersionUpdates',
  'versionUpdatesError',
  'onCreateNamedVersion',
  'onRenameVersion',
  'onDeleteVersion',
  'onRestoreVersion',
  'userRole',
  'onNavigateToDoc',
  'docGuid',
];

export function VersionHistoryProvider({ value, children }) {
  return (
    <VersionHistoryContext.Provider value={value}>
      {children}
    </VersionHistoryContext.Provider>
  );
}

/**
 * Resolve each context key as: explicit prop → context → supplied default.
 *
 * `undefined` means "not supplied" at every level, which is exactly how React
 * default parameters behave, so a component's declared defaults keep working.
 */
export function useVersionHistoryValues(props = {}, defaults = {}) {
  const context = useContext(VersionHistoryContext);
  const resolved = {};
  for (const key of CONTEXT_KEYS) {
    if (props[key] !== undefined) {
      resolved[key] = props[key];
    } else if (context && context[key] !== undefined) {
      resolved[key] = context[key];
    } else {
      resolved[key] = defaults[key];
    }
  }
  return resolved;
}

export default VersionHistoryContext;
