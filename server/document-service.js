/**
 * Document Service - Application layer for document updates
 *
 * Provides a unified interface for both WebSocket and MCP tools
 * to update documents. Ensures all updates go through the in-memory
 * ydoc cache and are broadcast to connected clients.
 */
const Y = require('yjs');

let getYDocFn = null;
let extractDocGuidFn = null;

/**
 * Initialize with server exports
 * @param {function(string, boolean): Y.Doc} getYDoc - Function to get shared ydoc
 * @param {function(string): string} extractDocGuid - Function to extract clean UUID
 */
function init(getYDoc, extractDocGuid) {
  getYDocFn = getYDoc;
  extractDocGuidFn = extractDocGuid;
}

/**
 * Get the shared in-memory ydoc for a document
 * @param {string} docGuid - Document UUID
 * @returns {Y.Doc} The shared WSSharedDoc instance
 */
function getSharedDoc(docGuid) {
  if (!getYDocFn) {
    throw new Error('Document service not initialized');
  }

  // y-websocket expects "s/{docGuid}" format
  const docName = `s/${docGuid}`;
  return getYDocFn(docName);
}

/**
 * Apply a function to a document with proper transacting
 * @param {string} docGuid - Document UUID
 * @param {function(Y.Doc): void} updateFn - Function that modifies the ydoc
 * @param {string|null} userId - User ID for attribution
 * @returns {Promise<void>} Promise that resolves when persistence completes
 */
async function updateDocument(docGuid, updateFn, userId = null) {
  const ydoc = getSharedDoc(docGuid);

  // Capture the update event and wait for persistence
  const persistencePromise = new Promise((resolve) => {
    const updateHandler = (update, origin) => {
      ydoc.off('update', updateHandler);
      // Wait for async persistence to complete
      setTimeout(resolve, 100);
    };

    ydoc.once('update', updateHandler);

    // Fallback timeout in case update doesn't fire
    setTimeout(() => {
      ydoc.off('update', updateHandler);
      resolve();
    }, 500);
  });

  // Apply changes in a transaction
  // The update event will automatically trigger:
  // 1. Broadcast to WebSocket clients (via updateHandler)
  // 2. Persistence to database with userId attribution (via bindState listener)
  ydoc.transact(() => {
    updateFn(ydoc);
  }, userId); // Pass userId as origin for attribution

  // Wait for the update event and persistence to complete
  await persistencePromise;
}

module.exports = {
  init,
  getSharedDoc,
  updateDocument,
};
