/**
 * Shared test doubles for feature 037 (imports announce presence).
 *
 * Two collaborators are stubbed across the 037 suites, and both need the same
 * shape everywhere so the presence and fan-out suites can't drift:
 *
 *  - `makeRedisPubSubDouble()` — records `publishUpdate` calls and lets a test
 *    flip `isEnabled()` or make the publish throw (contracts/live-fanout.md F1–F8).
 *  - `makeAgentPresenceDouble()` — `getOrCreateSession` can resolve, reject or
 *    hang on demand (contracts/import-presence.md C1–C5), and every
 *    `setTemporarySelection` call is recorded for the changed-range assertions
 *    (C6–C9).
 *
 * The doubles deliberately mirror the REAL modules' signatures rather than
 * inventing a convenience API: `getOrCreateSession(docGuid, agentToken,
 * durationSeconds, options)` and `setTemporarySelection(sessionId, anchor,
 * head)`. Suites that need real awareness semantics (announce/silence/claim)
 * use the in-process harness in server/mcp/__tests__/presence-real-awareness.test.js
 * instead — these doubles exist for the ORCHESTRATION questions (was it called,
 * when, with what identity, and did a failure leak) that a real session cannot
 * answer deterministically.
 */

/**
 * Redis pub/sub double.
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=true] - initial isEnabled() answer
 * @returns {object} the double, plus `published`, `setEnabled`, `failWith`
 */
function makeRedisPubSubDouble({ enabled = true } = {}) {
  let isOn = enabled;
  let publishError = null;
  const published = [];

  return {
    // --- the real redis-pubsub surface the code under test uses ---
    isEnabled: () => isOn,
    publishUpdate: (docId, update) => {
      published.push({ docId, update });
      if (publishError) throw publishError;
    },

    // --- test controls ---
    published,
    setEnabled(next) { isOn = next; },
    /** Make the next (and every) publishUpdate throw. Pass null to clear. */
    failWith(err) { publishError = err; },
    reset() { published.length = 0; publishError = null; isOn = enabled; },
  };
}

/**
 * Agent-presence double.
 *
 * `mode` controls what getOrCreateSession does:
 *   'resolve' (default) — resolves a fake session after `delayMs`
 *   'reject'            — rejects with `error`
 *   'hang'              — returns a promise that never settles
 *
 * @param {object} [opts]
 * @param {'resolve'|'reject'|'hang'} [opts.mode='resolve']
 * @param {number} [opts.delayMs=0]
 * @param {Error} [opts.error]
 * @param {string} [opts.sessionId='session-1']
 */
function makeAgentPresenceDouble({
  mode = 'resolve',
  delayMs = 0,
  error = new Error('presence backend unavailable'),
  sessionId = 'session-1',
} = {}) {
  const sessions = [];
  const selections = [];
  const highlights = [];
  let current = { mode, delayMs, error, sessionId };
  const pendingTimers = [];

  const double = {
    // --- the real agent-presence surface ---
    getOrCreateSession(docGuid, agentToken, durationSeconds, options) {
      sessions.push({ docGuid, agentToken, durationSeconds, options });
      if (current.mode === 'reject') return Promise.reject(current.error);
      if (current.mode === 'hang') return new Promise(() => {});
      if (!current.delayMs) {
        return Promise.resolve({ sessionId: current.sessionId, docGuid, agentInfo: null });
      }
      return new Promise((resolve) => {
        const t = setTimeout(
          () => resolve({ sessionId: current.sessionId, docGuid, agentInfo: null }),
          current.delayMs
        );
        if (typeof t.unref === 'function') t.unref();
        pendingTimers.push(t);
      });
    },
    setTemporarySelection(sid, anchor, head) {
      selections.push({ sessionId: sid, anchor, head });
      return true;
    },
    // FR-014: nothing in this feature may reach the modify-style sweep. Present
    // on the double purely so a test can assert it was never called.
    queueHighlightSequence(...args) {
      highlights.push(args);
      return true;
    },

    // --- test controls / recordings ---
    sessions,
    selections,
    highlights,
    /** Switch behavior mid-test, e.g. double.behave({ mode: 'reject' }). */
    behave(next) { current = { ...current, ...next }; },
    reset() {
      sessions.length = 0;
      selections.length = 0;
      highlights.length = 0;
      for (const t of pendingTimers.splice(0)) clearTimeout(t);
    },
  };

  return double;
}

module.exports = { makeRedisPubSubDouble, makeAgentPresenceDouble };
