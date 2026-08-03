/**
 * Structural drift guard for feature 043's extractions (contract X-GUARD).
 *
 * The suites for X2/X3/X4 now drive the real modules, but a passing unit test
 * still cannot prove that PRODUCTION consults them — `server/index.js` could
 * quietly grow a second copy of any of these and every test would stay green.
 * That is exactly the failure mode this feature exists to kill, so it gets the
 * same treatment feature 038 gave the edit gate (the C1 guard at the bottom of
 * ws-edit-gate.test.js): source greps, one level up from behavior.
 *
 * The negative assertions are the load-bearing half. A positive grep only says
 * the module is referenced; the negatives say no re-inlined copy exists beside
 * it. Re-inlining is how a mirror grows back.
 *
 * ── X1 ──────────────────────────────────────────────────────────────────────
 * X1 (the bindState update listener → server/collab-bind-state.js) landed in a
 * follow-on pass. It had been blocked because feature 041's structural pins in
 * `server/__tests__/bindstate-failure.test.js` grepped `server/index.js` for
 * `if (ydoc._bindFailed) return;` and for the `refuseBind({ ... })` call, both
 * of which live inside the block X1 moves. Those two pins were repointed at
 * `server/collab-bind-state.js` with their regexes unchanged byte for byte —
 * drift protection follows the code to its new home. G1-G3 below are the other
 * half of that: they prove index.js consults the module rather than keeping a
 * copy beside it.
 */
const fs = require('fs');
const path = require('path');

describe('043 extraction guard: server/index.js uses the extracted units (X-GUARD)', () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  /**
   * `indexSrc` with comments stripped, for the "this must not appear"
   * assertions — several of the extracted units are DESCRIBED in prose that
   * would otherwise trip a negative grep.
   *
   * The block-comment pattern is anchored to the start of a line on purpose. An
   * unanchored `/\*[\s\S]*?\*\//` is fooled by a `/*` inside a string literal —
   * index.js's CSP directives contain `https://*.googleusercontent.com`, and the
   * naive version swallowed ~4KB of real code after it, including the whole
   * `setPersistence` call. That silently broke the POSITIVE greps below. Every
   * genuine block comment in this file starts its own line.
   */
  const indexCode = indexSrc
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('the comment stripper does not swallow real code (guards the guard)', () => {
    // If this regresses, the negative assertions below start passing vacuously.
    expect(indexCode).toMatch(/setPersistence\(\{/);
    expect(indexCode).toMatch(/module\.exports\s*=/);
  });

  // ── X1: the bindState update listener ─────────────────────────────────────

  test('G1: index.js builds its persistence bindState from collab-bind-state', () => {
    expect(indexSrc).toMatch(/require\(['"]\.\/collab-bind-state['"]\)/);
    expect(indexCode).toMatch(/createBindState\s*\(/);
  });

  test('G2: index.js attaches no document update listener of its own', () => {
    // The listener is the ONLY writer of user_id / agent_name / via_sync for a
    // live edit. A second `ydoc.on('update')` in index.js would be a second
    // attribution path, and the US1/US2 E2Es would be guarding the wrong one.
    expect(indexCode).not.toMatch(/ydoc\.on\(\s*['"]update['"]/);
  });

  test('G3: index.js contains no re-inlined classify/attribute/persist sequence', () => {
    // The signature of the moved block: parse the origin, read the sync marker,
    // then persist with both. Any one of these reappearing in index.js means the
    // listener grew back.
    expect(indexCode).not.toMatch(/parseOrigin\s*\(/);
    expect(indexCode).not.toMatch(/viaSyncFromOrigin\s*\(/);
    expect(indexCode).not.toMatch(/classificationDisabled\s*\(/);
    expect(indexCode).not.toMatch(/classifyByXml\s*\(/);
    expect(indexCode).not.toMatch(/persistenceProvider\.storeUpdate\s*\(/);
  });

  // ── X2: identityFromPrincipal ─────────────────────────────────────────────

  test('G4a: index.js derives connection identity through identityFromPrincipal', () => {
    expect(indexSrc).toMatch(/require\(['"]\.\/agent-identity['"]\)/);
    expect(indexCode).toMatch(/identityFromPrincipal\s*\(/);
  });

  test('G4c: the derivation\'s RESULT is what lands on the connection', () => {
    // Calling identityFromPrincipal is not the claim — ASSIGNING its result is.
    // Without these two, `ws.userId = req.query.userId ?? wsIdentity.userId`, or
    // dropping/reordering the assignments outright, passes G4a and G4b, passes
    // every E2E (the harness makes its own correct assignment at
    // __tests__/integration/helpers/collab-harness.js:356-358), and
    // misattributes in production only.
    expect(indexCode).toMatch(/ws\.userId = wsIdentity\.userId/);
    expect(indexCode).toMatch(/ws\.agentName = wsIdentity\.agentName/);
  });

  test('G4b: index.js contains no hand-rolled isAgent identity derivation', () => {
    // The historical misattribution bug was fixed by deriving identity from the
    // token. A second, inline copy of that derivation is a second place for it
    // to regress, and the copy is what US1 would then be failing to guard.
    expect(indexCode).not.toMatch(/agentName\s*=\s*req\.user\??\.?\s*\.?isAgent\s*\?/);
    expect(indexCode).not.toMatch(/ws\.agentName\s*=\s*req\.user/);
  });

  // ── X3: shouldPublishToRedis ──────────────────────────────────────────────

  test('G5a: index.js routes cross-instance publishes through shouldPublishToRedis', () => {
    expect(indexCode).toMatch(/shouldPublishToRedis\s*\(/);
  });

  test('G5b: index.js contains no re-inlined document-update skip-list', () => {
    // Narrower than "no ORIGIN_REDIS literal anywhere" on purpose: the AWARENESS
    // publish handler legitimately keeps its own `origin === ORIGIN_REDIS`
    // feedback-loop check, which is a different predicate about a different
    // event and is not part of X3. What must not come back is the DOCUMENT
    // skip-list, which is the pair.
    expect(indexCode).not.toMatch(/origin\s*===\s*ORIGIN_REDIS\s*\|\|\s*origin\s*===\s*ORIGIN_DB_LOAD/);
  });

  // ── X4: the undo-status router ────────────────────────────────────────────

  test('G6a: index.js mounts the undo-status router', () => {
    expect(indexSrc).toMatch(/require\(['"]\.\/api\/undo-status['"]\)/);
    expect(indexCode).toMatch(/createUndoStatusRouter\s*\(/);
  });

  test('G6b: index.js declares no undo-status route of its own', () => {
    expect(indexCode).not.toMatch(/['"]\/api\/docs\/:docId\/undo-status['"]/);
  });

  // ── G7: the budget ceiling itself ─────────────────────────────────────────

  test('G7: the extraction ceiling held — the upgrade handler and gate did not move', () => {
    // Deliberately duplicates feature 038's C1 guard, as a tripwire on THIS
    // feature's own budget (ledger D9). The upgrade handler and the installGate
    // call site are the two things 043 promised not to touch; if a future
    // extraction moves either, this fails in the feature that caused it rather
    // than only in 038's suite.
    expect(indexSrc.match(/installGate\s*\(/g)).toHaveLength(1);
    expect(indexSrc).toMatch(
      /request\.tokenMayWrite\s*=\s*!Array\.isArray\(user\.scopes\)\s*\|\|\s*user\.scopes\.includes\('documents:write'\)/
    );
    // The OTHER authorization axis, pinned for the same reason. The shared
    // harness re-declares this computation as a literal
    // (collab-harness.js:353) because the upgrade handler is outside 043's
    // extraction budget — so if production ever changed the edit threshold, the
    // harness would keep gating on the old one and US2's negative control (a
    // viewer's step2 must be blocked) would silently be testing stale rules.
    // The tokenMayWrite literal above already had this protection; this line
    // did not.
    expect(indexSrc).toMatch(
      /tokenMayWrite && documents\.ROLES\[userRole\] >= documents\.ROLES\['editor'\]/
    );
  });

  // ── G8: the cross-instance ownership relay (multi-replica review M4) ───────
  //
  // The protocol-level suite for M4
  // (__tests__/integration/awareness-spoof-block.test.js) has to REPRODUCE the
  // relay, because index.js cannot be required from a test. That mirror is only
  // honest while production still calls the same two functions the same way —
  // which is exactly what a source grep, one level up from behavior, can say.
  // Without this, index.js could stop vouching for its participants and every
  // suite would stay green while a cross-pod reconnect went invisible again.

  test('G8a: index.js vouches for its own participants when it publishes awareness', () => {
    expect(indexSrc).toMatch(/localOwnersOf:\s*awarenessLocalOwnersOf/);
    expect(indexCode).toMatch(
      /publishAwareness\(\s*docId,\s*update,\s*awarenessLocalOwnersOf\(doc,\s*changedClients\)\s*\)/
    );
  });

  test('G8b: index.js teaches the ledger BEFORE it applies a relayed frame', () => {
    // Order is the whole point: the ledger's own listener stamps the "somebody
    // remote" placeholder on ids that arrive with no connection behind them, so
    // learning has to happen first or the upgrade is immediately re-buried.
    expect(indexSrc).toMatch(/learnRelayedOwners:\s*awarenessLearnRelayedOwners/);
    const learnAt = indexCode.indexOf('awarenessLearnRelayedOwners(doc, owners)');
    const applyAt = indexCode.indexOf('applyAwarenessUpdate(');
    expect(learnAt).toBeGreaterThan(-1);
    expect(applyAt).toBeGreaterThan(learnAt);
  });

  test('G8c: index.js decides no ownership of its own — the guard owns that', () => {
    // It carries the map between publisher and receiver and nothing more; a
    // principal lookup re-inlined here would be the second ownership model
    // feature 044 exists to prevent.
    expect(indexCode).not.toMatch(/REMOTE_PRINCIPAL/);
  });
});
