/**
 * Check if a click event should use standard browser link behavior
 * (opening in new tab, new window, etc.) instead of custom handling.
 *
 * Returns true for:
 * - Cmd+Click (Mac) / Ctrl+Click (Windows/Linux) - open in new tab
 * - Shift+Click - open in new window
 * - Middle mouse button - open in new tab
 *
 * @param {MouseEvent} event - The click event
 * @returns {boolean} True if browser should handle the click normally
 */
export function shouldUseBrowserLinkBehavior(event) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0;
}
