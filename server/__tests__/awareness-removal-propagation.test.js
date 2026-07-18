/**
 * Awareness REMOVALS must propagate cross-instance (regression, 2026-07-18).
 *
 * The Redis awareness publisher in server/index.js (redisAwarenessHandler)
 * encodes `added.concat(updated).concat(removed)`. It previously dropped
 * `removed`, so a client that cleared its state — an agent presence session
 * silenced on claim loss (feature 015), or a ws-close eviction — was never
 * announced as gone to other instances. Remote browsers kept a ghost avatar
 * until y-protocols' 30s staleness prune; observed in prod during the 015
 * validation as duplicate agent avatars persisting after a claim handoff.
 *
 * These tests pin the relay semantics against REAL y-protocols Awareness
 * instances: encoding a removed client's (null) state and applying it on a
 * second instance must delete the client there — and the pre-fix client list
 * (added+updated only) demonstrably leaves the ghost.
 */

const Y = require('yjs');
const awarenessProtocol = require('y-protocols/dist/awareness.cjs');

// Relay one awareness change from `source` to `remote` the way
// redisAwarenessHandler → publishAwareness → applyAwarenessUpdate does,
// using the given changed-client list.
function relay(source, remote, changedClients) {
  const update = awarenessProtocol.encodeAwarenessUpdate(source, changedClients);
  awarenessProtocol.applyAwarenessUpdate(remote, update, 'test-redis');
}

function makePair() {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const local = new awarenessProtocol.Awareness(docA);
  const remote = new awarenessProtocol.Awareness(docB);
  return { local, remote };
}

describe('awareness removal propagation (index.js redisAwarenessHandler contract)', () => {
  test('a silenced client (setLocalState(null)) is removed on the remote instance when `removed` is relayed', () => {
    const { local, remote } = makePair();
    let lastChange = null;
    local.on('update', (change) => { lastChange = change; });

    // Announce, relay to remote.
    local.setLocalState({ user: { name: 'Squire Docs Assistant (Sam)', isAgent: true } });
    relay(local, remote, lastChange.added.concat(lastChange.updated).concat(lastChange.removed));
    expect(remote.getStates().has(local.clientID)).toBe(true);

    // Silence (claim lost). The change reports the client under `removed`.
    local.setLocalState(null);
    expect(lastChange.removed).toContain(local.clientID);

    // Fixed handler list: added+updated+removed → remote drops the ghost.
    relay(local, remote, lastChange.added.concat(lastChange.updated).concat(lastChange.removed));
    expect(remote.getStates().has(local.clientID)).toBe(false);
  });

  test('the pre-fix client list (added+updated only) leaves a ghost on the remote — why `removed` is required', () => {
    const { local, remote } = makePair();
    let lastChange = null;
    local.on('update', (change) => { lastChange = change; });

    local.setLocalState({ user: { name: 'Squire Docs Assistant (Sam)', isAgent: true } });
    relay(local, remote, lastChange.added.concat(lastChange.updated));
    expect(remote.getStates().has(local.clientID)).toBe(true);

    local.setLocalState(null);
    const preFixList = lastChange.added.concat(lastChange.updated); // drops `removed`
    if (preFixList.length > 0) relay(local, remote, preFixList);

    // Ghost persists: the remote never heard about the removal.
    expect(remote.getStates().has(local.clientID)).toBe(true);
  });

  test('the fixed source line includes removed clients', () => {
    // Cheap tripwire on the actual handler source: the publisher must build
    // its client list from added, updated, AND removed.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../index.js'), 'utf8');
    expect(src).toMatch(/added\.concat\(updated\)\.concat\(removed\)/);
  });
});
