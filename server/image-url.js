/**
 * Helpers for the app image URL form (/api/docs/:docId/images/:imageId) — the
 * only src a document image node may carry. Centralized so the build, strict
 * validation, and parse logic don't drift across the upload route, the agent
 * guardrail, and the chat tools. (The client keeps its own copy in
 * client/src/components/ImageNodeView.jsx since it can't import server code.)
 */

// Anchored on purpose: validation must REJECT srcs that merely contain the
// pattern (e.g. https://evil.com/api/docs/x/images/y).
const APP_IMAGE_URL = /^\/api\/docs\/([^/]+)\/images\/([^/?#]+)$/;

/** Build the app URL for a document image. */
function imageUrl(docId, imageId) {
  return `/api/docs/${docId}/images/${imageId}`;
}

/** Parse an app image URL into { docId, imageId }, or null if it isn't one. */
function parseAppImageUrl(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(APP_IMAGE_URL);
  return m ? { docId: m[1], imageId: m[2] } : null;
}

/** Whether value is a well-formed app image URL. */
function isAppImageUrl(value) {
  return parseAppImageUrl(value) !== null;
}

module.exports = { imageUrl, parseAppImageUrl, isAppImageUrl, APP_IMAGE_URL };
