/**
 * Feature 010, US2 (FR-014/015, SC-003): with a numeric trust-proxy hop count,
 * a forged X-Forwarded-For chain cannot change req.ip / the limiter key, so a
 * client can't spoof its way around a per-IP budget. Existing req.protocol /
 * buildBaseUrl consumers keep working.
 */
process.env.RL_TEST_ENABLE = '1';
process.env.RL_FORCE_MEMORY = '1';
process.env.RL_AUTH_PER_MIN = '3';

const { randomUUID } = require('crypto');
const request = require('supertest');
const express = require('express');
const rateLimit = require('../rate-limit');
const { buildBaseUrl } = require('../url');

// Mirror the production posture: numeric hop count (not blanket `true`).
function buildApp(hops) {
  const app = express();
  app.set('trust proxy', Number(hops));
  app.get('/auth/echo', (req, res) => res.json({ ip: req.ip, protocol: req.protocol, baseUrl: buildBaseUrl(req) }));
  app.get('/auth/thing', rateLimit.perIp('auth'), (req, res) => res.json({ ok: true, ip: req.ip }));
  return app;
}

describe('trust proxy — spoof resistance (FR-015)', () => {
  beforeEach(() => rateLimit._reset());

  it('a forged X-Forwarded-For chain does not change the trusted-hop req.ip', async () => {
    const app = buildApp(1);
    // With trust proxy=1, the client-appended leftmost entries are untrusted;
    // req.ip resolves to the same trusted-hop address regardless of the forgery.
    const r1 = await request(app).get('/auth/echo').set('X-Forwarded-For', 'AAA.forged, 203.0.113.9');
    const r2 = await request(app).get('/auth/echo').set('X-Forwarded-For', 'BBB.different-forgery, 203.0.113.9');
    expect(r1.body.ip).toBe(r2.body.ip);
    expect(r1.body.ip).toBe('203.0.113.9');
  });

  it('forged entries cannot spoof around a per-IP budget (0 over-budget successes)', async () => {
    const app = buildApp(1);
    const trueEdge = '198.51.100.7';
    let successes = 0;
    // 6 requests, each with a UNIQUE forged leftmost entry but the same trusted
    // edge. A naive keying on the forged value would let all 6 through.
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .get('/auth/thing')
        .set('X-Forwarded-For', `forged-${randomUUID()}, ${trueEdge}`);
      if (res.status === 200) successes++;
    }
    // Budget is 3/min for the true edge — spoofing bought no extra headroom.
    expect(successes).toBe(3);
  });

  it('no X-Forwarded-For header → keys on the socket IP (shared budget)', async () => {
    const app = buildApp(1);
    let over = 0;
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/auth/thing'); // no XFF
      if (i >= 3 && res.status === 429) over++;
    }
    expect(over).toBeGreaterThan(0); // requests past the budget are rejected
  });

  it('req.protocol and buildBaseUrl still resolve at the configured hop count', async () => {
    const app = buildApp(2);
    const res = await request(app)
      .get('/auth/echo')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-For', 'client, edge');
    expect(res.body.protocol).toBe('https'); // XFP honored at the trusted hop
    expect(typeof res.body.baseUrl).toBe('string');
    expect(res.body.baseUrl.startsWith('https://')).toBe(true);
  });
});
