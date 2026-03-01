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
 * @param {string|null} agentName - Agent name for attribution (e.g., 'Chat Assistant')
 * @returns {Promise<void>} Promise that resolves when update is applied and persistence is initiated
 */
async function updateDocument(docGuid, updateFn, userId = null, agentName = null) {
  const ydoc = getSharedDoc(docGuid);

  // Track whether update fired
  let updateFired = false;
  let updateHandler;

  // Create a promise that resolves when the update event fires
  // The update event fires synchronously at the end of the transaction
  const updatePromise = new Promise((resolve) => {
    updateHandler = () => {
      updateFired = true;
      ydoc.off('update', updateHandler);
      // Allow event loop to process (persistence starts asynchronously)
      // Use setImmediate to ensure async persistence has been initiated
      setImmediate(resolve);
    };

    ydoc.once('update', updateHandler);
  });

  // Apply changes in a transaction
  // The update event will automatically trigger:
  // 1. Broadcast to WebSocket clients (via updateHandler)
  // 2. Persistence to database with userId attribution (via bindState listener)
  const origin = agentName ? { userId, agentName } : userId;
  ydoc.transact(() => {
    updateFn(ydoc);
  }, origin); // Pass origin for attribution

  // Wait for the update event to fire and async operations to be initiated
  // If no changes were made, the update event won't fire and we timeout
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      if (!updateFired) {
        ydoc.off('update', updateHandler);
      }
      resolve();
    }, 50);
  });

  await Promise.race([updatePromise, timeoutPromise]);
}

module.exports = {
  init,
  getSharedDoc,
  updateDocument,
};
