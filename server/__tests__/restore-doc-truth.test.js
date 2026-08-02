/**
 * Doc-truth drift guard for the restore/undo surfaces (feature 041, US7,
 * FR-018/FR-019, SC-011).
 *
 * These are the surfaces developers and agents read to learn how restore and
 * undo behave. After the 2026-08-02 design amendment (a human web-UI restore is
 * not recorded and not an undo target; an agent's restore is a recorded edit its
 * own undo inverts) three of them still described the pre-cut world. Stale
 * docstrings are how the next regression gets written — agents take these
 * literally (Constitution Principle I).
 *
 * Cheap grep-level assertions, in the style of agents-md-claims.test.js: if a
 * future change breaks one, the surface must be brought back into agreement in
 * the same commit.
 */
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('041 SC-011: restore/undo documentation surfaces carry no pre-cut claims', () => {
  test('agent-identity.js no longer says a web-UI restore is recorded under the chat identity', () => {
    const src = read('agent-identity.js');
    // The pre-cut claim, in its shipped phrasing and any close variant.
    expect(src).not.toMatch(/A web-UI restore is recorded under this identity/i);
    expect(src).not.toMatch(/web-UI restore[^.]*\bis recorded under\b/i);
    // ...and it states the post-cut truth explicitly.
    expect(src).toMatch(/web-UI restore is NOT recorded here/i);
  });

  test('edit-records.js sentinel comment describes the assistant identity post-cut', () => {
    const src = read('undo/edit-records.js');
    expect(src).toMatch(/A human web-UI restore records NOTHING here/i);
    expect(src).not.toMatch(/is what a human web-UI restore now records under/i);
  });

  test('the MCP restore tool tells agents their restore is undoable by their own undo tool', () => {
    const src = read('mcp/tools/restore-document-version.js');
    expect(src).toMatch(/your own undo\s+tool inverts it/i);
    // The counter-restore path is still offered, but no longer as the ONLY way.
    expect(src).toMatch(/counter-restore/i);
    expect(src).not.toMatch(/so you can undo it by\s*\n?restoring to a version from before the restore/i);
  });

  test('no server source still claims a human web-UI restore is recorded under an agent identity', () => {
    const files = ['agent-identity.js', 'undo/edit-records.js', 'api/chat.js', 'version-history.js'];
    for (const rel of files) {
      const src = read(rel);
      expect(src).not.toMatch(/identity a web-UI restore is RECORDED/i);
    }
  });
});
