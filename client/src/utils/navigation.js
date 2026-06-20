// Matches the doc-viewer routes `/d/<guid>` and `/doc/<guid>` (prefix match —
// any trailing path like `/versions` is ignored). App.jsx uses its own anchored
// variants to route between the editor and versions views.
const DOC_PATH_RE = /^\/d(?:oc)?\/([0-9a-f-]+)/i;

/**
 * Extract the lowercased docGuid from a path like `/d/<guid>` or `/doc/<guid>`.
 * @param {string} path  a URL pathname
 * @returns {string|null} the docGuid, or null if the path isn't a doc route
 */
export function parseDocGuid(path) {
  const match = (path || '').match(DOC_PATH_RE);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Navigate within the SPA: push the path and dispatch a popstate event so the
 * app's history-based router re-renders for the new location.
 * @param {string} path
 */
export function spaNavigate(path) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
