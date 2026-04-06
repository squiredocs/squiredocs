/**
 * Chat persistence store
 * Stores and retrieves AI chat conversations (messages as JSONB).
 *
 * SECURITY: Every query that reads or mutates a specific chat MUST include
 * `AND user_id = $N` to enforce ownership. Never load, save, or update a
 * chat by ID alone — always require the caller to pass userId.
 */

let pool = null;

function init(dbPool) {
  pool = dbPool;
}

/**
 * Create a new chat for a user
 * @param {string} userId - User UUID
 * @returns {Promise<string>} Chat ID
 */
async function createChat(userId) {
  if (!pool) throw new Error('Chat store not initialized');
  const { generateId } = require('ai');
  const id = generateId();
  await pool.query(
    'INSERT INTO chats (id, user_id) VALUES ($1, $2)',
    [id, userId]
  );
  return id;
}

/**
 * Load chat messages by ID (with ownership check)
 * @param {string} id - Chat ID
 * @param {string} userId - User UUID (ownership check)
 * @returns {Promise<Array>} UIMessage array
 */
async function loadChat(id, userId) {
  if (!pool) throw new Error('Chat store not initialized');
  const result = await pool.query(
    'SELECT messages FROM chats WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return result.rows[0]?.messages || [];
}

/**
 * Save messages to a chat (full replace, with ownership check)
 * @param {string} chatId - Chat ID
 * @param {string} userId - User UUID (ownership check)
 * @param {Array} messages - UIMessage array
 */
async function saveChat(chatId, userId, messages) {
  if (!pool) throw new Error('Chat store not initialized');
  await pool.query(
    'UPDATE chats SET messages = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
    [JSON.stringify(messages), chatId, userId]
  );
}

/**
 * Get chats for a user (metadata only), with cursor-based pagination.
 * @param {string} userId - User UUID
 * @param {object} [opts]
 * @param {number} [opts.limit=50] - Max rows to return
 * @param {string} [opts.before] - ISO timestamp cursor — return chats updated before this value
 * @returns {Promise<Array<{id: string, title: string, createdAt: string, updatedAt: string}>>}
 */
async function getChatsForUser(userId, { limit = 50, before } = {}) {
  if (!pool) throw new Error('Chat store not initialized');
  if (before) {
    const result = await pool.query(
      'SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt" FROM chats WHERE user_id = $1 AND updated_at < $2 ORDER BY updated_at DESC LIMIT $3',
      [userId, before, limit]
    );
    return result.rows;
  }
  const result = await pool.query(
    'SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt" FROM chats WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2',
    [userId, limit]
  );
  return result.rows;
}

/**
 * Delete a chat (with ownership check)
 * @param {string} id - Chat ID
 * @param {string} userId - User UUID (ownership check)
 * @returns {Promise<boolean>} True if deleted
 */
async function deleteChat(id, userId) {
  if (!pool) throw new Error('Chat store not initialized');
  const result = await pool.query(
    'DELETE FROM chats WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return result.rowCount > 0;
}

/**
 * Update chat title (with ownership check)
 * @param {string} id - Chat ID
 * @param {string} userId - User UUID (ownership check)
 * @param {string} title - New title
 */
async function updateChatTitle(id, userId, title) {
  if (!pool) throw new Error('Chat store not initialized');
  const result = await pool.query(
    'UPDATE chats SET title = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
    [title, id, userId]
  );
  return result.rowCount > 0;
}

module.exports = {
  init,
  createChat,
  loadChat,
  saveChat,
  getChatsForUser,
  deleteChat,
  updateChatTitle,
};
