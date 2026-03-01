/**
 * Chat store unit tests
 * Tests chat-store.js module against a real PostgreSQL database.
 */
const crypto = require('crypto');
const chatStore = require('../chat-store');
const { createPool, createTestUser } = require('./helpers/db');

describe('Chat Store', () => {
  let pool;
  let testUserId;

  beforeAll(async () => {
    pool = createPool();
    chatStore.init(pool);

    // Create a test user
    testUserId = await createTestUser(pool, `chattest-${crypto.randomUUID()}@test.com`);
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM chats WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query('DELETE FROM chats WHERE user_id = $1', [testUserId]);
  });

  describe('createChat', () => {
    test('creates a chat and returns an ID', async () => {
      const id = await chatStore.createChat(testUserId);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);

      // Verify it exists in DB
      const result = await pool.query('SELECT * FROM chats WHERE id = $1', [id]);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].user_id).toBe(testUserId);
      expect(result.rows[0].messages).toEqual([]);
    });
  });

  describe('loadChat', () => {
    test('returns empty array for new chat', async () => {
      const id = await chatStore.createChat(testUserId);
      const messages = await chatStore.loadChat(id);
      expect(messages).toEqual([]);
    });

    test('returns empty array for non-existent chat', async () => {
      const messages = await chatStore.loadChat('non-existent-id');
      expect(messages).toEqual([]);
    });
  });

  describe('saveChat', () => {
    test('saves messages to a chat', async () => {
      const id = await chatStore.createChat(testUserId);
      const messages = [
        { id: 'msg1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
        { id: 'msg2', role: 'assistant', parts: [{ type: 'text', text: 'Hi!' }] },
      ];

      await chatStore.saveChat(id, messages);

      const loaded = await chatStore.loadChat(id);
      expect(loaded).toEqual(messages);
    });

    test('updates updated_at timestamp', async () => {
      const id = await chatStore.createChat(testUserId);
      const before = await pool.query('SELECT updated_at FROM chats WHERE id = $1', [id]);

      // Small delay to ensure timestamp changes
      await new Promise(resolve => setTimeout(resolve, 10));

      await chatStore.saveChat(id, [{ id: 'msg1', role: 'user', parts: [] }]);
      const after = await pool.query('SELECT updated_at FROM chats WHERE id = $1', [id]);

      expect(new Date(after.rows[0].updated_at).getTime())
        .toBeGreaterThanOrEqual(new Date(before.rows[0].updated_at).getTime());
    });
  });

  describe('getChatsForUser', () => {
    test('returns empty array when no chats', async () => {
      const chats = await chatStore.getChatsForUser(testUserId);
      expect(chats).toEqual([]);
    });

    test('returns chats ordered by updated_at DESC', async () => {
      const id1 = await chatStore.createChat(testUserId);
      const id2 = await chatStore.createChat(testUserId);

      // Update the first chat so it becomes most recently updated
      await chatStore.saveChat(id1, [{ id: 'msg', role: 'user', parts: [] }]);

      const chats = await chatStore.getChatsForUser(testUserId);
      expect(chats.length).toBe(2);
      expect(chats[0].id).toBe(id1); // most recently updated
      expect(chats[1].id).toBe(id2);
    });

    test('returns metadata without messages', async () => {
      const id = await chatStore.createChat(testUserId);
      await chatStore.updateChatTitle(id, 'Test Title');

      const chats = await chatStore.getChatsForUser(testUserId);
      expect(chats[0]).toHaveProperty('id');
      expect(chats[0]).toHaveProperty('title', 'Test Title');
      expect(chats[0]).toHaveProperty('createdAt');
      expect(chats[0]).toHaveProperty('updatedAt');
      expect(chats[0]).not.toHaveProperty('messages');
    });
  });

  describe('deleteChat', () => {
    test('deletes a chat owned by the user', async () => {
      const id = await chatStore.createChat(testUserId);
      const deleted = await chatStore.deleteChat(id, testUserId);
      expect(deleted).toBe(true);

      const result = await pool.query('SELECT * FROM chats WHERE id = $1', [id]);
      expect(result.rows.length).toBe(0);
    });

    test('returns false when chat does not exist', async () => {
      const deleted = await chatStore.deleteChat('nonexistent', testUserId);
      expect(deleted).toBe(false);
    });

    test('returns false when user does not own the chat', async () => {
      const id = await chatStore.createChat(testUserId);
      const deleted = await chatStore.deleteChat(id, crypto.randomUUID());
      expect(deleted).toBe(false);

      // Chat should still exist
      const result = await pool.query('SELECT * FROM chats WHERE id = $1', [id]);
      expect(result.rows.length).toBe(1);
    });
  });

  describe('updateChatTitle', () => {
    test('updates the title of a chat', async () => {
      const id = await chatStore.createChat(testUserId);
      await chatStore.updateChatTitle(id, 'My Chat Title');

      const result = await pool.query('SELECT title FROM chats WHERE id = $1', [id]);
      expect(result.rows[0].title).toBe('My Chat Title');
    });
  });
});
