/**
 * Feature 034 (T015/T016) — the append-only auth-event trail.
 *
 * The trail is what turns a per-account snapshot into evidence: it preserves the
 * SEQUENCE a spray detector needs (shared-IP grouping over time, and the
 * exhaust-grant-then-respawn pattern). Under test here:
 *
 *   - exactly one row per completed authentication, with the right event type
 *     and the channel of THIS event (FR-003, RBD-7);
 *   - token refresh appends NOTHING (FR-005) — asserted end-to-end against the
 *     real /auth/refresh route, plus structurally (the route calls neither
 *     user-store helper);
 *   - the 180-day purge boundary, which touches only auth_events (FR-010);
 *   - FK cascade with the user (FR-009);
 *   - record() swallows every failure and never throws (FR-008, SC-003).
 *
 * APPEND-ONLY REVIEWER NOTE: the only mutation paths for auth_events anywhere in
 * server/ are the INSERT in auth-events.record() and the DELETE in
 * auth-events.purgeOlderThan() (plus the FK cascade). There is no UPDATE and no
 * per-row DELETE. The grep-style assertion at the bottom of this file enforces
 * that; if it ever fails, the trail has stopped being append-only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createPool } = require('../../__tests__/helpers/db');

process.env.ACCESS_TOKEN_SECRET = 'test-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

const users = require('../users');
const authEvents = require('../auth-events');
const authRouter = require('../routes');
const { generateRefreshToken } = require('../jwt');

const EMAIL_SUFFIX = '@auth-events.test.example.com';

describe('auth_events trail (feature 034)', () => {
  let pool;

  const newProfile = () => ({
    googleId: `evt-${crypto.randomUUID()}`,
    email: `evt-${crypto.randomUUID()}${EMAIL_SUFFIX}`,
    name: 'Trail User',
    picture: null,
  });

  const eventsFor = async (userId) => {
    const { rows } = await pool.query(
      'SELECT event, signup_source, ip, user_agent, created_at FROM auth_events WHERE user_id = $1 ORDER BY id',
      [userId]
    );
    return rows;
  };

  /** One completed authentication through the two shared helpers. */
  const authenticate = async (profile, ctx = {}) => {
    const user = await users.findOrCreateUser(profile, ctx);
    await users.updateLastLogin(user.id, { ...ctx, isNew: user.isNew });
    return user;
  };

  beforeAll(async () => {
    pool = createPool();
    users.init(pool); // also initializes auth-events with the same pool
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE email LIKE '%${EMAIL_SUFFIX}'`);
    await pool.end();
  });

  describe('append semantics', () => {
    test('a new account appends exactly one signup event (US2 acceptance 1)', async () => {
      const user = await authenticate(newProfile(), {
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Signup)',
        signupSource: 'browser',
      });

      const rows = await eventsFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].event).toBe('signup');
      expect(rows[0].signup_source).toBe('browser');
      expect(rows[0].ip).toBe('203.0.113.7');
      expect(rows[0].user_agent).toBe('Mozilla/5.0 (Signup)');
      expect(rows[0].created_at).toBeInstanceOf(Date);
    });

    test('a returning account appends exactly one login event (US2 acceptance 2)', async () => {
      const profile = newProfile();
      const user = await authenticate(profile, { ip: '203.0.113.7' });
      await authenticate(profile, { ip: '198.51.100.9' });

      const rows = await eventsFor(user.id);
      expect(rows.map((r) => r.event)).toEqual(['signup', 'login']);
      expect(rows[1].ip).toBe('198.51.100.9');
    });

    test('signup_source records the channel of THIS event (design gap G-1 default)', async () => {
      const profile = newProfile();
      const user = await authenticate(profile, { signupSource: 'browser', ip: '203.0.113.7' });
      // The same account later signs in through the agent consent round-trip.
      await authenticate(profile, { signupSource: 'agent_oauth', ip: '203.0.113.7' });

      const rows = await eventsFor(user.id);
      expect(rows.map((r) => r.signup_source)).toEqual(['browser', 'agent_oauth']);
    });

    test('a signup followed by two logins yields exactly three rows (US2 independent test)', async () => {
      const profile = newProfile();
      const user = await authenticate(profile, { ip: '203.0.113.7' });
      await authenticate(profile, { ip: '203.0.113.7' });
      await authenticate(profile, { ip: '203.0.113.7' });

      const rows = await eventsFor(user.id);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.event)).toEqual(['signup', 'login', 'login']);
    });

    test('findOrCreateUser alone appends nothing (RBD-7 — the row is updateLastLogin\'s)', async () => {
      const user = await users.findOrCreateUser(newProfile(), { ip: '203.0.113.7' });
      expect(await eventsFor(user.id)).toHaveLength(0);
    });

    test('feature 059: record() stores the signin_link channel (RBD-059-6)', async () => {
      const user = await users.findOrCreateUser(newProfile(), {});
      expect(await authEvents.record({ userId: user.id, event: 'login', signupSource: 'signin_link' })).toBe(true);
      const rows = await eventsFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].signup_source).toBe('signin_link');
      // Unknown values still coerce to the default.
      await authEvents.record({ userId: user.id, event: 'login', signupSource: 'nonsense' });
      expect((await eventsFor(user.id))[1].signup_source).toBe('browser');
    });

    test('null ip and null user-agent are stored independently', async () => {
      const user = await authenticate(newProfile(), { ip: null, userAgent: 'UA only' });
      const rows = await eventsFor(user.id);
      expect(rows[0].ip).toBeNull();
      expect(rows[0].user_agent).toBe('UA only');

      const user2 = await authenticate(newProfile(), { ip: '203.0.113.7', userAgent: null });
      const rows2 = await eventsFor(user2.id);
      expect(rows2[0].ip).toBe('203.0.113.7');
      expect(rows2[0].user_agent).toBeNull();
    });
  });

  describe('token refresh appends nothing (FR-005, US2 acceptance 3)', () => {
    test('hitting /auth/refresh leaves the trail and the capture columns untouched', async () => {
      const app = express();
      app.use(express.json());
      app.use(cookieParser());
      app.use('/auth', authRouter);

      const user = await authenticate(newProfile(), {
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Signup)',
      });
      const before = await pool.query('SELECT count(*)::int AS n FROM auth_events');
      const beforeUser = await users.findById(user.id);

      const refreshToken = generateRefreshToken(beforeUser);
      const res = await request(app)
        .post('/auth/refresh')
        .set('Cookie', [`refreshToken=${refreshToken}`])
        // A refresh carries a totally different user-agent; nothing may record it.
        .set('User-Agent', 'RefreshBot/9.9');

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();

      const after = await pool.query('SELECT count(*)::int AS n FROM auth_events');
      expect(after.rows[0].n).toBe(before.rows[0].n);

      const afterUser = await users.findById(user.id);
      expect(afterUser.signup_ip).toBe(beforeUser.signup_ip);
      expect(afterUser.signup_user_agent).toBe(beforeUser.signup_user_agent);
      expect(afterUser.last_login_ip).toBe(beforeUser.last_login_ip);
      expect(afterUser.last_login_user_agent).toBe(beforeUser.last_login_user_agent);
      expect(afterUser.last_login_at.getTime()).toBe(beforeUser.last_login_at.getTime());
    });

    test('structurally: the refresh route calls neither user-store helper', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'routes.js'), 'utf8');
      const start = source.indexOf("router.post('/refresh'");
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf('router.', start + 10);
      const body = source.slice(start, end);
      expect(body).not.toMatch(/findOrCreateUser|updateLastLogin/);
      // Feature 059 (T022): nor any of the identity-era sign-in helpers.
      expect(body).not.toMatch(/resolveIdentityUser|establishSession|completePostAuth/);
    });
  });

  describe('retention (FR-010)', () => {
    test('purgeOlderThan(180) deletes a 181-day-old row and keeps a 179-day-old one', async () => {
      const user = await authenticate(newProfile(), { ip: '203.0.113.7', userAgent: 'UA' });
      await pool.query('DELETE FROM auth_events WHERE user_id = $1', [user.id]);
      await pool.query(
        `INSERT INTO auth_events (user_id, event, signup_source, ip, created_at)
         VALUES ($1, 'login', 'browser', '203.0.113.7', now() - interval '181 days'),
                ($1, 'login', 'browser', '203.0.113.7', now() - interval '179 days')`,
        [user.id]
      );

      const deleted = await authEvents.purgeOlderThan(180);
      expect(deleted).toBeGreaterThanOrEqual(1);

      const rows = await eventsFor(user.id);
      expect(rows).toHaveLength(1);
      const ageDays = (Date.now() - rows[0].created_at.getTime()) / 86_400_000;
      expect(ageDays).toBeLessThan(180);
    });

    test('the purge never touches the users capture columns (FR-010 exemption)', async () => {
      const user = await authenticate(newProfile(), {
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Kept)',
      });
      await pool.query(
        `UPDATE auth_events SET created_at = now() - interval '200 days' WHERE user_id = $1`,
        [user.id]
      );

      await authEvents.purgeOlderThan(180);

      expect(await eventsFor(user.id)).toHaveLength(0);
      const after = await users.findById(user.id);
      expect(after.signup_ip).toBe('203.0.113.7');
      expect(after.signup_user_agent).toBe('Mozilla/5.0 (Kept)');
      expect(after.last_login_ip).toBe('203.0.113.7');
    });

    test('RETENTION_DAYS is 180', () => {
      expect(authEvents.RETENTION_DAYS).toBe(180);
    });

    test('startPurgeJob is idempotent and stopPurgeJob is safe when never started', async () => {
      authEvents.stopPurgeJob(); // safe no-op
      authEvents.startPurgeJob({ intervalMs: 3_600_000 });
      authEvents.startPurgeJob({ intervalMs: 3_600_000 }); // no second timer
      authEvents.stopPurgeJob();
      authEvents.stopPurgeJob(); // safe twice
      // Give the fire-and-forget boot sweeps a tick to settle so the pool is
      // not closed underneath them by afterAll.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });

  describe('lifecycle (FR-009)', () => {
    test('deleting the user cascades away all of their events', async () => {
      const profile = newProfile();
      const user = await authenticate(profile, { ip: '203.0.113.7' });
      await authenticate(profile, { ip: '203.0.113.7' });
      expect(await eventsFor(user.id)).toHaveLength(2);

      await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
      expect(await eventsFor(user.id)).toHaveLength(0);
    });
  });

  describe('failure tolerance (FR-008, SC-003)', () => {
    const withPool = async (stub, fn) => {
      authEvents.init(stub);
      try {
        return await fn();
      } finally {
        authEvents.init(pool); // restore the real pool
      }
    };

    test('record() returns false and does not throw when the pool rejects', async () => {
      const rejecting = { query: () => Promise.reject(new Error('connection lost')) };
      await withPool(rejecting, async () => {
        await expect(
          authEvents.record({ userId: crypto.randomUUID(), event: 'login' })
        ).resolves.toBe(false);
      });
    });

    test('record() returns false when init was never called (uninitialized pool)', async () => {
      await withPool(null, async () => {
        await expect(
          authEvents.record({ userId: crypto.randomUUID(), event: 'login' })
        ).resolves.toBe(false);
      });
    });

    test('record() returns false for a missing userId rather than throwing', async () => {
      await expect(authEvents.record({ event: 'login' })).resolves.toBe(false);
      await expect(authEvents.record()).resolves.toBe(false);
    });

    test('an out-of-domain event is coerced, not a CHECK violation', async () => {
      const user = await users.findOrCreateUser(newProfile());
      await expect(
        authEvents.record({ userId: user.id, event: 'password-reset', signupSource: 'smoke-signals' })
      ).resolves.toBe(true);

      const rows = await eventsFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].event).toBe('login');
      expect(rows[0].signup_source).toBe('browser');
    });

    test('a failing trail write does not prevent the sign-in (FR-008)', async () => {
      const rejecting = { query: () => Promise.reject(new Error('trail is down')) };
      const profile = newProfile();
      const user = await users.findOrCreateUser(profile, { ip: '203.0.113.7' });

      await withPool(rejecting, async () => {
        await expect(
          users.updateLastLogin(user.id, { ip: '203.0.113.7', userAgent: 'UA', isNew: true })
        ).resolves.toBeUndefined();
      });

      // The snapshot landed even though the trail write was swallowed.
      const after = await users.findById(user.id);
      expect(after.last_login_ip).toBe('203.0.113.7');
      expect(await eventsFor(user.id)).toHaveLength(0);
    });
  });

  describe('append-only invariant', () => {
    test('no code in server/ updates or per-row deletes auth_events', () => {
      const serverDir = path.join(__dirname, '..', '..');
      const offenders = [];

      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!entry.name.endsWith('.js')) continue;
          const src = fs.readFileSync(full, 'utf8');
          if (/UPDATE\s+auth_events/i.test(src)) offenders.push(`${full}: UPDATE`);
          // The ONLY permitted delete is the retention sweep's age predicate.
          const deletes = src.match(/DELETE\s+FROM\s+auth_events[^`'"]*/gi) || [];
          for (const stmt of deletes) {
            if (!/created_at\s*<\s*now\(\)/i.test(stmt)) offenders.push(`${full}: ${stmt.trim()}`);
          }
        }
      };

      walk(serverDir);
      expect(offenders).toEqual([]);
    });
  });
});
