/**
 * Review M2 (2026-08-03 pre-deploy review of the 041-047 train): the WebSocket
 * upgrade handler must answer the socket when an async lookup throws.
 *
 * `server.on('upgrade')` awaits `permissions.extractUser` and
 * `permissions.can.view`, both of which throw when the database is down. Since
 * 046 closes degraded editors with 1013, a DB outage sends every one of them
 * back through this handler on ~2.5s retry loops — unguarded, each attempt
 * died as an unhandledRejection (one page per attempt through the process
 * handler, draining the shared notification budget) and left the TCP socket
 * unanswered until the client's own timeout.
 *
 * index.js boots a live server on require, so the rule is PINNED by source,
 * following the bindstate-failure.test.js convention for index.js internals.
 * The pins are structural: the whole decision chain sits inside a try, and the
 * catch answers 503 and destroys the socket.
 */
const fs = require('fs');
const path = require('path');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

const start = indexSource.indexOf("server.on('upgrade'");
const end = indexSource.indexOf('// Presence cleanup note', start);
const upgradeHandler = indexSource.slice(start, end);

describe('PIN: the upgrade handler fails closed on thrown lookups (review M2)', () => {
  test('the handler slice was found', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  test('the handler body opens with a try', () => {
    expect(upgradeHandler).toMatch(
      /server\.on\('upgrade', async \(request, socket, head\) => \{\s*\n\s*try \{/
    );
  });

  test('both awaited lookups sit inside the try', () => {
    const tryIndex = upgradeHandler.indexOf('try {');
    const catchIndex = upgradeHandler.indexOf('} catch (err)');
    expect(tryIndex).toBeGreaterThan(-1);
    expect(catchIndex).toBeGreaterThan(tryIndex);
    for (const lookup of ['permissions.extractUser', 'permissions.can.view']) {
      const at = upgradeHandler.indexOf(lookup);
      expect(at).toBeGreaterThan(tryIndex);
      expect(at).toBeLessThan(catchIndex);
    }
  });

  test('the catch answers 503 and destroys the socket', () => {
    const catchBlock = upgradeHandler.slice(upgradeHandler.indexOf('} catch (err)'));
    expect(catchBlock).toMatch(/503 Service Unavailable/);
    expect(catchBlock).toMatch(/socket\.destroy\(\)/);
  });
});
