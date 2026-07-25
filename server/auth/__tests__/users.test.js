/**
 * Users module tests
 * Requires PostgreSQL database with users table
 */
const crypto = require('crypto');
const { createPool } = require('../../__tests__/helpers/db');

const users = require('../users');

describe('Users module', () => {
  let pool;

  beforeAll(async () => {
    pool = createPool();
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

  describe('updateName', () => {
    test('updates user name', async () => {
      const profile = {
        googleId: `test-google-${crypto.randomUUID()}`,
        email: `test-${crypto.randomUUID()}@example.com`,
        name: 'Original Name',
        picture: null,
      };

      const user = await users.findOrCreateUser(profile);
      const updated = await users.updateName(user.id, 'New Name');

      expect(updated.name).toBe('New Name');
      expect(updated.id).toBe(user.id);
      expect(updated.email).toBe(profile.email);
    });

    test('returns updated row from database', async () => {
      const profile = {
        googleId: `test-google-${crypto.randomUUID()}`,
        email: `test-${crypto.randomUUID()}@example.com`,
        name: 'Original Name',
        picture: null,
      };

      const user = await users.findOrCreateUser(profile);
      await users.updateName(user.id, 'Persisted Name');

      const found = await users.findById(user.id);
      expect(found.name).toBe('Persisted Name');
    });

    test('throws for non-existent user', async () => {
      await expect(
        users.updateName('00000000-0000-0000-0000-000000000000', 'Name')
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

  /**
   * Feature 034 (T008/T016) — the per-account capture snapshot.
   *
   * The two guarantees under test: the signup pair is written ONCE at creation
   * and is never overwritten by a later login through the same upsert path
   * (FR-001), and the last-login pair is refreshed on every login (FR-002).
   * Capture also has to fail open — a missing header, an unparsable address, or
   * a broken trail write must still leave a successful sign-in (FR-008).
   */
  describe('signup/login IP + user-agent capture (feature 034)', () => {
    const newProfile = () => ({
      googleId: `test-google-${crypto.randomUUID()}`,
      email: `test-${crypto.randomUUID()}@example.com`,
      name: 'Capture User',
      picture: null,
    });

    const captureRow = async (userId) => {
      const { rows } = await pool.query(
        `SELECT signup_ip, signup_user_agent, last_login_ip, last_login_user_agent, last_login_at
         FROM users WHERE id = $1`,
        [userId]
      );
      return rows[0];
    };

    test('writes the signup pair at account creation (FR-001)', async () => {
      const user = await users.findOrCreateUser(newProfile(), {
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Signup)',
      });

      expect(user.isNew).toBe(true);
      const row = await captureRow(user.id);
      expect(row.signup_ip).toBe('203.0.113.7');
      expect(row.signup_user_agent).toBe('Mozilla/5.0 (Signup)');
    });

    test('NEVER overwrites the signup pair on a returning-user upsert (FR-001)', async () => {
      const profile = newProfile();
      const created = await users.findOrCreateUser(profile, {
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Signup)',
      });

      // Same googleId, different capture context — this is the relay-spray
      // scenario's second visit, and the once-only guarantee is what makes the
      // signup origin trustworthy months later.
      const returning = await users.findOrCreateUser(profile, {
        ip: '198.51.100.9',
        userAgent: 'Mozilla/5.0 (Later)',
      });

      expect(returning.id).toBe(created.id);
      expect(returning.isNew).toBe(false);
      const row = await captureRow(created.id);
      expect(row.signup_ip).toBe('203.0.113.7');
      expect(row.signup_user_agent).toBe('Mozilla/5.0 (Signup)');
    });

    test('updateLastLogin refreshes the last-login pair alongside the timestamp (FR-002)', async () => {
      const user = await users.findOrCreateUser(newProfile(), {
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Signup)',
      });

      await users.updateLastLogin(user.id, {
        ip: '198.51.100.9',
        userAgent: 'Mozilla/5.0 (Later)',
      });

      const row = await captureRow(user.id);
      expect(row.last_login_ip).toBe('198.51.100.9');
      expect(row.last_login_user_agent).toBe('Mozilla/5.0 (Later)');
      expect(row.last_login_at).toBeInstanceOf(Date);
      // ...and the signup pair is still the original.
      expect(row.signup_ip).toBe('203.0.113.7');
      expect(row.signup_user_agent).toBe('Mozilla/5.0 (Signup)');
    });

    test('first sign-in leaves signup and last-login pairs identical (US1 acceptance 1)', async () => {
      const ctx = { ip: '2001:db8::1', userAgent: 'Mozilla/5.0 (First)' };
      const user = await users.findOrCreateUser(newProfile(), ctx);
      await users.updateLastLogin(user.id, { ...ctx, isNew: user.isNew });

      const row = await captureRow(user.id);
      expect(row.last_login_ip).toBe(row.signup_ip);
      expect(row.last_login_user_agent).toBe(row.signup_user_agent);
      expect(row.signup_ip).toBe('2001:db8::1');
    });

    test('stores an IPv4-mapped IPv6 address (::ffff: dual-stack form)', async () => {
      const user = await users.findOrCreateUser(newProfile(), {
        ip: '::ffff:127.0.0.1',
        userAgent: 'Mozilla/5.0',
      });
      const row = await captureRow(user.id);
      // Postgres normalizes the mapped form; the address must round-trip as an
      // address, not error out.
      expect(row.signup_ip).toBeTruthy();
    });

    test('context-less calls still succeed and store NULL (backward compatibility)', async () => {
      const user = await users.findOrCreateUser(newProfile());
      await users.updateLastLogin(user.id);

      const row = await captureRow(user.id);
      expect(row.signup_ip).toBeNull();
      expect(row.signup_user_agent).toBeNull();
      expect(row.last_login_ip).toBeNull();
      expect(row.last_login_user_agent).toBeNull();
      expect(row.last_login_at).toBeInstanceOf(Date);
    });

    test('a sign-in with no user-agent stores NULL and succeeds (US3 acceptance 1)', async () => {
      const user = await users.findOrCreateUser(newProfile(), {
        ip: '203.0.113.7',
        userAgent: null,
      });
      await users.updateLastLogin(user.id, { ip: '203.0.113.7', userAgent: null });

      const row = await captureRow(user.id);
      expect(row.signup_ip).toBe('203.0.113.7');
      expect(row.signup_user_agent).toBeNull();
      expect(row.last_login_user_agent).toBeNull();
    });

    test('a 512-char user-agent (authContext already truncated) stores exactly 512 chars (US3 acceptance 2)', async () => {
      // authContext bounds the value; users.js stores what it is handed. This
      // asserts the storage side accepts the full bound without complaint.
      const bounded = 'U'.repeat(512);
      const user = await users.findOrCreateUser(newProfile(), {
        ip: '203.0.113.7',
        userAgent: bounded,
      });
      const row = await captureRow(user.id);
      expect(row.signup_user_agent).toHaveLength(512);
    });

    test('an unavailable address stores NULL and the sign-in succeeds (US3 acceptance 3)', async () => {
      const user = await users.findOrCreateUser(newProfile(), {
        ip: null,
        userAgent: 'Mozilla/5.0 (No IP)',
      });
      await users.updateLastLogin(user.id, { ip: null, userAgent: 'Mozilla/5.0 (No IP)' });

      const row = await captureRow(user.id);
      expect(row.signup_ip).toBeNull();
      expect(row.last_login_ip).toBeNull();
      expect(row.signup_user_agent).toBe('Mozilla/5.0 (No IP)');
    });

    test('updateLastLogin still updates the timestamp when the trail write fails (FR-008)', async () => {
      const user = await users.findOrCreateUser(newProfile(), { ip: '203.0.113.7' });
      const authEvents = require('../auth-events');
      const spy = jest
        .spyOn(authEvents, 'record')
        .mockRejectedValue(new Error('trail is down'));

      try {
        // Even a REJECTING record() must not surface into the auth path.
        await expect(
          users.updateLastLogin(user.id, { ip: '198.51.100.9', userAgent: 'UA' })
        ).resolves.toBeUndefined();
      } finally {
        spy.mockRestore();
      }

      const row = await captureRow(user.id);
      expect(row.last_login_ip).toBe('198.51.100.9');
      expect(row.last_login_at).toBeInstanceOf(Date);
    });
  });
});



