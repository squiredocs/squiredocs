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
  });
});
