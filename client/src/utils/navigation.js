/** Push a path to the browser history and trigger SPA navigation. */
export function spaNavigate(path) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
