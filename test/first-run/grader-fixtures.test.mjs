/**
 * Feature 030 US4 (T017, FR-028, SC-003) — deterministic grader regression test.
 *
 * Asserts the hardened grader closes the 029 false-PASS vectors, using the three
 * committed stream-json fixtures. Runs with NO model access (pure parse + grade).
 *
 *   node --test test/first-run/grader-fixtures.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCapture } from './capture.mjs';
import { gradeTranscript } from './grade-transcript.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const SERVER_ORIGIN = 'http://localhost:3001';

function gradeFixture(name) {
  const raw = fs.readFileSync(path.join(FIX, `${name}.jsonl`), 'utf8');
  const capture = parseCapture(raw);
  const grade = gradeTranscript(capture, { serverOrigin: SERVER_ORIGIN });
  const item = (id) => grade.items.find((i) => i.id === id);
  return { grade, item };
}

test('quote-only transcript FAILs the performable items (5 byte-channel, 6 doc-URL)', () => {
  const { item } = gradeFixture('quote-only-transcript');
  assert.equal(item(5).pass, false, 'item 5 (byte-channel sync) must FAIL — nothing was performed');
  assert.equal(item(6).pass, false, 'item 6 (doc URL) must FAIL — no doc created');
});

test('incidental /d/… path FAILs the doc-URL item (6) despite a sync event', () => {
  const { item } = gradeFixture('incidental-docpath');
  assert.equal(item(6).pass, false, 'item 6 must FAIL — the delivered URL is not on the server origin');
  // item 5 passes here (a real sync happened) — isolating the origin-anchor vector.
  assert.equal(item(5).pass, true, 'item 5 (byte-channel sync) passes — a real sync event is present');
});

test('genuine performing transcript PASSes the performable items (5 and 6)', () => {
  const { item } = gradeFixture('genuine-performing');
  assert.equal(item(5).pass, true, 'item 5 (byte-channel sync) must PASS — real import event');
  assert.equal(item(6).pass, true, 'item 6 (doc URL) must PASS — server-origin URL corroborated by a doc-creating event');
});

test('a failed byte move (import recipe returned, curl 403s) FAILs items 5 and 6 despite a fabricated doc URL', () => {
  const { item } = gradeFixture('failed-sync');
  // The is_error blind spot (030 review): import_markdown_file returned a recipe,
  // but the recipe's curl import failed (is_error:true) and the model printed a
  // fabricated doc URL from the recipe's docGuid. Neither performable item may pass.
  assert.equal(item(5).pass, false, 'item 5 (byte-channel sync) must FAIL — the curl byte move 403d, nothing landed');
  assert.equal(item(6).pass, false, 'item 6 (doc URL) must FAIL — the delivered URL is fabricated, uncorroborated by a landed sync');
});

test('performable items fail closed when the capture carries no event data (RBD-2)', () => {
  // A flat prose-only capture (structured:false) must not pass performable items.
  const grade = gradeTranscript({ prose: 'I used import_markdown_file and delivered http://localhost:3001/d/abcdef.', events: [], structured: false }, { serverOrigin: SERVER_ORIGIN });
  const item = (id) => grade.items.find((i) => i.id === id);
  assert.equal(item(5).pass, false, 'item 5 fails closed without events');
  assert.equal(item(6).pass, false, 'item 6 fails closed without events');
});

test('silent-reconnect item (4) FAILs on a success-ceremony block, PASSes when silent (RBD-10)', () => {
  const ceremony = gradeTranscript({ prose: 'Connection successful! 🎉 You are now connected. Now let me find your spec.', events: [], structured: true }, { serverOrigin: SERVER_ORIGIN });
  const silent = gradeTranscript({ prose: 'The tools are available. Looking for a spec in your repo now.', events: [], structured: true }, { serverOrigin: SERVER_ORIGIN });
  const item4 = (g) => g.items.find((i) => i.id === 4).pass;
  assert.equal(item4(ceremony), false, 'ceremony block must FAIL item 4');
  assert.equal(item4(silent), true, 'correctly-silent content must PASS item 4');
});
