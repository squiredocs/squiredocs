#!/usr/bin/env node
/**
 * Feature 029 US4 — coaching-contract transcript grader (FR-023, SC-008).
 *
 * Emits an explicit PASS/FAIL for each of the seven coaching-contract checklist
 * items against a rehearsal transcript. In M1 the GRADER ITSELF is the
 * deliverable: with the stub plugin most items are expected to FAIL and exactly
 * one planted marker PASSes, proving the grader detects both (RBD-8). Clean
 * passes across the matrix are M2's exit, not M1's.
 *
 * Usage:
 *   node test/first-run/grade-transcript.mjs <transcript-file>
 *   node test/first-run/grade-transcript.mjs --require-all <transcript-file>   # exit 1 if any item FAILs (M2)
 *   cat transcript | node test/first-run/grade-transcript.mjs -
 *
 * Programmatic:  import { gradeTranscript } from './grade-transcript.mjs'
 */
import fs from 'node:fs';

/**
 * The seven coaching-contract checklist items (data-model.md / FR-023). Each has
 * a `test(transcript, lines)` returning true when the coaching behavior is
 * present. Kept deliberately simple + line-oriented so the grade is deterministic.
 */
export const CHECKLIST = [
  {
    id: 1,
    name: 'signup-creates-account line appears before the browser step',
    test(t) {
      const m = t.match(/sign(?:ing)?[- ]?in creates[^.\n]*account/i);
      if (!m) return false;
      const signupIdx = m.index;
      // "browser step" = the first mention of the browser / an authorize URL / consent.
      const browserMatch = t.match(/\b(open (?:your |the )?browser|authoriz|consent|\/mcp\/auth\/authorize)/i);
      const browserIdx = browserMatch ? browserMatch.index : Infinity;
      return signupIdx < browserIdx;
    },
  },
  {
    id: 2,
    name: 'bare authorization URL on its own line',
    test(t, lines) {
      return lines.some((l) => /^\s*https?:\/\/\S+$/.test(l) && /authoriz|oauth/i.test(l));
    },
  },
  {
    id: 3,
    name: 'expected localhost-callback failure handled via paste-back',
    test(t) {
      return /localhost[^\n]*(fail|failed|didn'?t|couldn'?t|can'?t|won'?t|not reachable|refused)/i.test(t)
        && /paste([- ]back)?/i.test(t);
    },
  },
  {
    id: 4,
    name: 'silent reconnect and continuation after consent',
    test(t) {
      return /(silently|automatically|seamlessly)?\s*reconnect(?:s|ed|ing)?\b/i.test(t)
        && /(continu|resume|pick(?:s| back)? up|carry on)/i.test(t);
    },
  },
  {
    id: 5,
    name: 'byte-channel (never-retyped) file sync used',
    test(t) {
      return /byte[- ]channel/i.test(t)
        && (/never[^\n]*re-?typ/i.test(t) || /curl[^\n]*sk_sqd_/i.test(t) || /import_markdown_file/i.test(t));
    },
  },
  {
    id: 6,
    name: 'doc URL delivered (the payoff)',
    test(t) {
      return /https?:\/\/\S*\/d\/[a-z0-9-]{6,}/i.test(t) || /\/d\/[a-z0-9-]{6,}/i.test(t);
    },
  },
  {
    id: 7,
    name: 'the loop taught (read-spec-before / write-back-after standing behavior)',
    test(t) {
      return /(read[^\n]*spec[^\n]*before|write[- ]?back[^\n]*after|standing (?:behavior|loop|habit)|before you (?:start|touch)[^\n]*read)/i.test(t);
    },
  },
];

/**
 * Grade a transcript string against the checklist.
 * @param {string} transcript
 * @returns {{ items: Array<{id,name,pass}>, passed:number, failed:number, total:number }}
 */
export function gradeTranscript(transcript) {
  const t = String(transcript || '');
  const lines = t.split(/\r?\n/);
  const items = CHECKLIST.map((c) => ({ id: c.id, name: c.name, pass: !!c.test(t, lines) }));
  const passed = items.filter((i) => i.pass).length;
  return { items, passed, failed: items.length - passed, total: items.length };
}

/** Render a human-readable report. */
export function formatReport(result) {
  const rows = result.items
    .map((i) => `  [${i.pass ? 'PASS' : 'FAIL'}] ${i.id}. ${i.name}`)
    .join('\n');
  return `Coaching-contract grade: ${result.passed}/${result.total} PASS\n${rows}`;
}

// CLI entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const requireAll = args.includes('--require-all');
  const fileArg = args.find((a) => a !== '--require-all');
  if (!fileArg) {
    console.error('usage: grade-transcript.mjs [--require-all] <transcript-file | ->');
    process.exit(2);
  }
  const transcript = fileArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(fileArg, 'utf8');
  const result = gradeTranscript(transcript);
  console.log(formatReport(result));
  // M1: the report IS the deliverable — exit 0 even with expected FAILs.
  // M2: --require-all makes any FAIL a non-zero exit (matrix must be clean).
  process.exit(requireAll && result.failed > 0 ? 1 : 0);
}
