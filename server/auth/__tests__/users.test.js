/**
 * Users module tests
 * Requires PostgreSQL database with users table
 */
const { Pool } = require('pg');
const crypto = require('crypto');

const users = require('../users');

describe('Users module', () => {
  let pool;
  
  // Test database config
  const testDbConfig = process.env.TEST_DATABASE_URL || {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.TEST_DB_NAME || 'collab_db',
    user: process.env.DB_USER || process.env.USER || 'postgres',
    password: process.env.DB_PASSWORD || ''
  };

  beforeAll(async () => {
    pool = new Pool(testDbConfig);
    users.init(pool);
    
    // Ensure users table exists (migration should have run)
    await pool.query('SELECT 1 FROM users LIMIT 1');
  });

  afterAll(async () => {
    await pool.end();
  });

  // Clean up test users after each test
  afterEach(async () => {
    await pool.query("DELETE FROM users WHERE email LIKE 'test-%@example.com'");
  });

  describe('init', () => {
    test('initializes with a pool', () => {
      // Re-init to verify it works
      expect(() => users.init(pool)).not.toThrow();
    });
  });

  describe('findOrCreateUser', () => {
    test('creates a new user', async () => {
      const profile = {
        googleId: `test-google-${crypto.randomUUID()}`,
        email: `test-${crypto.randomUUID()}@example.com`,
        name: 'Test User',
        picture: 'https://example.com/pic.jpg',
      };

      const user = await users.findOrCreateUser(profile);

      expect(user).toBeDefined();
      expect(user.id).toBeDefined();
      expect(user.google_id).toBe(profile.googleId);
      expect(user.email).toBe(profile.email);
      expect(user.name).toBe(profile.name);
      expect(user.picture).toBe(profile.picture);
      expect(user.token_version).toBe(0);
    });

    test('returns existing user by googleId', async () => {
      const googleId = `test-google-${crypto.randomUUID()}`;
      const profile = {
        googleId,
        email: `test-${crypto.randomUUID()}@example.com`,
        name: 'Test User',
        picture: 'https://example.com/pic.jpg',
      };

      // Create user first
      const user1 = await users.findOrCreateUser(profile);

      // Call again with same googleId
      const user2 = await users.findOrCreateUser({
        ...profile,
        name: 'Updated Name', // Changed name
      });

      expect(user2.id).toBe(user1.id);
      expect(user2.name).toBe('Updated Name'); // Name should be updated
    });

    test('updates existing user profile', async () => {
      const googleId = `test-google-${crypto.randomUUID()}`;
      const profile = {
        googleId,
        email: `test-${crypto.randomUUID()}@example.com`,
        name: 'Original Name',
        picture: 'https://example.com/old.jpg',
      };

      await users.findOrCreateUser(profile);

      // Update profile
      const updatedUser = await users.findOrCreateUser({
        googleId,
        email: profile.email,
        name: 'New Name',
        picture: 'https://example.com/new.jpg',
      });

      expect(updatedUser.name).toBe('New Name');
      expect(updatedUser.picture).toBe('https://example.com/new.jpg');
    });

    test('creates user without picture', async () => {
      const profile = {
        googleId: `test-google-${crypto.randomUUID()}`,
        email: `test-${crypto.randomUUID()}@example.com`,
        name: 'Test User',
        picture: null,
      };

      const user = await users.findOrCreateUser(profile);

      expect(user).toBeDefined();
      expect(user.picture).toBeNull();
    });
  });

  describe('findById', () => {
    test('returns user by ID', async () => {
      const profile = {
        googleId: `test-google-${crypto.randomUUID()}`,
        email: `test-${crypto.randomUUID()}@example.com`,
        name: 'Test User',
        picture: null,
      };

      const created = await users.findOrCreateUser(profile);
      const found = await users.findById(created.id);

      expect(found).toBeDefined();
      expect(found.id).toBe(created.id);
      expect(found.email).toBe(profile.email);
    });

    test('returns null for non-existent ID', async () => {
      const found = await users.findById('00000000-0000-0000-0000-000000000000');
      expect(found).toBeNull();
    });
  });

  describe('incrementTokenVersion', () => {
    test('increments token version', async () => {
      const profile = {
        googleId: `test-google-${crypto.randomUUID()}`,
        email: `test-${crypto.randomUUID()}@example.com`,
        name: 'Test User',
        picture: null,
      };

      const user = await users.findOrCreateUser(profile);
      expect(user.token_version).toBe(0);

      const updated = await users.incrementTokenVersion(user.id);
      expect(updated.token_version).toBe(1);

      const updated2 = await users.incrementTokenVersion(user.id);
      expect(updated2.token_version).toBe(2);
    });

    test('throws for non-existent user', async () => {
      await expect(
        users.incrementTokenVersion('00000000-0000-0000-0000-000000000000')
      ).rejects.toThrow('User not found');
    });
  });

  describe('getTokenVersion', () => {
    test('returns current token version', async () => {
      const profile = {
        googleId: `test-google-${crypto.randomUUID()}`,
        email: `test-${crypto.randomUUID()}@example.com`,
        name: 'Test User',
        picture: null,
      };

      const user = await users.findOrCreateUser(profile);
      
      const version = await users.getTokenVersion(user.id);
      expect(version).toBe(0);

      await users.incrementTokenVersion(user.id);
      
      const newVersion = await users.getTokenVersion(user.id);
      expect(newVersion).toBe(1);
    });

    test('throws for non-existent user', async () => {
      await expect(
        users.getTokenVersion('00000000-0000-0000-0000-000000000000')
      ).rejects.toThrow('User not found');
    });
  });
});

