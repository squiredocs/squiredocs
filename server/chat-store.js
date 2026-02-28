/**
 * Chat persistence store
 * Stores and retrieves AI chat conversations (messages as JSONB).
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
 * Load chat messages by ID
 * @param {string} id - Chat ID
 * @returns {Promise<Array>} UIMessage array
 */
async function loadChat(id) {
  if (!pool) throw new Error('Chat store not initialized');
  const result = await pool.query(
    'SELECT messages FROM chats WHERE id = $1',
    [id]
  );
  return result.rows[0]?.messages || [];
}

/**
 * Save messages to a chat (full replace)
 * @param {string} chatId - Chat ID
 * @param {Array} messages - UIMessage array
 */
async function saveChat(chatId, messages) {
  if (!pool) throw new Error('Chat store not initialized');
  await pool.query(
    'UPDATE chats SET messages = $1, updated_at = NOW() WHERE id = $2',
    [JSON.stringify(messages), chatId]
  );
}

/**
 * Get all chats for a user (metadata only)
 * @param {string} userId - User UUID
 * @returns {Promise<Array<{id: string, title: string, createdAt: string, updatedAt: string}>>}
 */
async function getChatsForUser(userId) {
  if (!pool) throw new Error('Chat store not initialized');
  const result = await pool.query(
    'SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt" FROM chats WHERE user_id = $1 ORDER BY updated_at DESC',
    [userId]
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
 * Update chat title
 * @param {string} id - Chat ID
 * @param {string} title - New title
 */
async function updateChatTitle(id, title) {
  if (!pool) throw new Error('Chat store not initialized');
  await pool.query(
    'UPDATE chats SET title = $1, updated_at = NOW() WHERE id = $2',
    [title, id]
  );
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
