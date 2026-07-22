#!/usr/bin/env node
/**
 * Coaching-contract transcript grader — 029 seven-item checklist, HARDENED for
 * 030 M2 (contracts/coaching-checklist.md, FR-025..028, RBD-2/10):
 *
 *   gradeTranscript(capture, { serverOrigin })
 *     capture = { prose, events, structured }   (from capture.mjs)
 *
 *   - prose items (1,2,3,7): matched semantically against capture.prose.
 *   - behavioral item (4): after tools (re-)appear the flow proceeds directly to
 *     find-the-spec with NO success-ceremony block; reconnection prose neither
 *     required nor penalized (RBD-10).
 *   - performable items (5,6): graded against capture.events (tool-call events),
 *     and FAIL CLOSED when event data is absent — never a prose fallback (RBD-2).
 *       5: a byte-channel sync event (import_markdown_file recipe, or a Bash curl
 *          import carrying an sk_sqd_ token / the export API).
 *       6: a delivered doc URL whose origin === serverOrigin AND corroborated by
 *          a doc-creating/import tool-call event (FR-025); incidental /d/… paths
 *          and other-origin URLs FAIL.
 *
 * Usage:
 *   node grade-transcript.mjs [--server-origin http://localhost:3001] [--require-all] <capture.jsonl | ->
 *
 * Programmatic:  import { gradeTranscript } from './grade-transcript.mjs'
 */
import fs from 'node:fs';
import { parseCapture } from './capture.mjs';

// --- event predicates -------------------------------------------------------

/** Tool basename, stripping any `mcp__<server>__` prefix the client adds. */
function toolBase(tool) {
  const t = String(tool || '');
  const m = t.match(/mcp__[^_]+(?:_[^_]+)*__(.+)$/) || t.match(/__([^_]+)$/);
  return m ? m[1] : t;
}

/** True if an event is a byte-channel file-sync (item 5). */
function isByteChannelSyncEvent(e) {
  if (!e) return false;
  const base = toolBase(e.tool);
  if (base === 'import_markdown_file') return true;
  const cmd = typeof e.input?.command === 'string' ? e.input.command : JSON.stringify(e.input || '');
  if (/\bcurl\b/.test(cmd) && (/\/api\/docs\/[^\s"']*\/import/.test(cmd) || /sk_sqd_/.test(cmd))) return true;
  // the import recipe is often a compound shell command carrying the claim + curl import
  if (/tokens\/claim/.test(cmd) && /\/import/.test(cmd)) return true;
  return false;
}

/** True if an event created/imported a doc (item 6 corroboration). */
function isDocCreatingEvent(e) {
  if (!e) return false;
  const base = toolBase(e.tool);
  if (base === 'import_markdown_file' || base === 'create_document') return true;
  return isByteChannelSyncEvent(e);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Origin string for a URL/base, or '' if unparseable. */
function originOf(u) {
  try { return new URL(u).origin; } catch { return ''; }
}

// --- the checklist ----------------------------------------------------------

export const CHECKLIST = [
  {
    id: 1,
    name: 'signup-creates-account line appears before the browser step',
    kind: 'prose',
    test({ prose }) {
      // Semantic match (ledger gap 7 / FR-026): a "sign in (with Google) creates
      // your account" / "no separate signup" line — tolerant of the model's
      // paraphrase of the authored expectation line.
      const signup =
        prose.match(/sign(?:ing|s|ed)?[- ]?in[^.\n]{0,60}creat\w*[^.\n]{0,30}account/i) ||
        prose.match(/creat\w*[^.\n]{0,30}account[^.\n]{0,60}sign(?:ing|s|ed)?[- ]?in/i) ||
        prose.match(/no separate sign[- ]?up/i) ||
        prose.match(/same click[^.\n]{0,40}account/i);
      if (!signup) return false;
      const signupIdx = signup.index;
      const browser = prose.match(/\b(open (?:your |the )?browser|authoriz|consent page|\/mcp\b|https?:\/\/\S*\/mcp\/auth)/i);
      const browserIdx = browser ? browser.index : Infinity;
      return signupIdx < browserIdx;
    },
  },
  {
    id: 2,
    name: 'bare authorization URL on its own line',
    kind: 'prose',
    test({ prose }) {
      const lines = prose.split(/\r?\n/);
      return lines.some((l) => /^\s*https?:\/\/\S+$/.test(l) && /authoriz|oauth|\/mcp\/auth/i.test(l));
    },
  },
  {
    id: 3,
    name: 'expected localhost-callback failure handled via paste-back',
    kind: 'prose',
    test({ prose }) {
      return /localhost[^\n]*(error|fail|failed|didn'?t|couldn'?t|can'?t|won'?t|not reachable|refused|expected)/i.test(prose)
        && /paste([- ]?back)?/i.test(prose);
    },
  },
  {
    id: 4,
    name: 'silent reconnect / no success ceremony',
    kind: 'behavioral',
    test({ prose }) {
      // RBD-10: the design's "success needs no ceremony" rule targets the moment
      // AFTER tools (re-)appear and BEFORE the find-the-spec step — no celebratory
      // block there. A closing payoff summary AFTER the sync (move 4) legitimately
      // states what happened and is NOT penalized. So we only FAIL on a ceremony
      // marker that appears BEFORE the first find-the-spec-step marker.
      const ceremony =
        /\b(you'?re (?:now )?(?:all )?(?:set|connected)|successfully connected|connection (?:is )?(?:now )?successful|congratulations|🎉|✅ *(?:connected|done|success))\b/i;
      const specStep =
        /(find(?:ing)?[^.\n]{0,20}spec|look(?:ing)?[^.\n]{0,20}spec|spec[- ]?shaped|spec candidate|\.kiro\/specs|\bspecs\/|\bCLAUDE\.md\b|starter spec)/i;
      const cer = prose.match(ceremony);
      if (!cer) return true; // correctly silent
      const step = prose.match(specStep);
      const stepIdx = step ? step.index : Infinity;
      // Ceremony only fails the item if it precedes the spec step (the reconnect
      // transition). Ceremony inside/after the payoff is fine.
      return cer.index >= stepIdx;
    },
  },
  {
    id: 5,
    name: 'byte-channel (never-retyped) file sync performed',
    kind: 'performable',
    test(_capture, { events, structured }) {
      if (!structured) return false; // fail closed — no event data (RBD-2)
      return events.some(isByteChannelSyncEvent);
    },
  },
  {
    id: 6,
    name: 'doc URL delivered (the payoff)',
    kind: 'performable',
    test({ prose }, { events, structured, serverOrigin }) {
      if (!structured) return false; // fail closed (RBD-2)
      const origin = originOf(serverOrigin);
      if (!origin) return false;
      // (a) a delivered URL on the server origin appears in the prose payoff.
      const urlRe = new RegExp(escapeRegExp(origin) + '\\/d\\/[a-z0-9-]{6,}', 'i');
      const deliveredInProse = urlRe.test(prose);
      // (b) corroborated by a doc-creating/import event, or a tool result that
      //     returned a doc URL on the server origin.
      const corroborated =
        events.some(isDocCreatingEvent) ||
        events.some((e) => typeof e.result === 'string' && urlRe.test(e.result));
      return deliveredInProse && corroborated;
    },
  },
  {
    id: 7,
    name: 'the loop taught (read-spec-before / write-back-after standing behavior)',
    kind: 'prose',
    test({ prose }) {
      return /(read[^\n]*spec[^\n]*before|before[^\n]*run[^\n]*read[^\n]*spec|write[- ]?(?:status|design)?[^\n]*back[^\n]*after|standing (?:behavior|loop|habit)|the loop)/i.test(prose)
        && /(write[^\n]*back|status|design|after (?:implement|each run|a run))/i.test(prose);
    },
  },
];

/**
 * Grade a structured capture against the checklist.
 * @param {{prose:string, events:Array, structured:boolean}} capture
 * @param {{ serverOrigin?: string }} [opts]
 */
export function gradeTranscript(capture, opts = {}) {
  // Defensive: accept a raw string (legacy) as prose-only, structured=false so
  // performable items fail closed rather than crashing.
  const cap = typeof capture === 'string'
    ? { prose: capture, events: [], structured: false }
    : { prose: capture?.prose || '', events: capture?.events || [], structured: !!capture?.structured };
  const serverOrigin = opts.serverOrigin || 'http://localhost:3001';
  const ctx = { events: cap.events, structured: cap.structured, serverOrigin };
  const items = CHECKLIST.map((c) => ({
    id: c.id, name: c.name, kind: c.kind, pass: !!c.test(cap, ctx),
  }));
  const passed = items.filter((i) => i.pass).length;
  return { items, passed, failed: items.length - passed, total: items.length };
}

/** Render a human-readable report. */
export function formatReport(result) {
  const rows = result.items
    .map((i) => `  [${i.pass ? 'PASS' : 'FAIL'}] ${i.id}. ${i.name} (${i.kind})`)
    .join('\n');
  return `Coaching-contract grade: ${result.passed}/${result.total} PASS\n${rows}`;
}

// CLI entrypoint — parses the input file through capture.mjs (stream-json).
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const requireAll = args.includes('--require-all');
  const soIdx = args.indexOf('--server-origin');
  const serverOrigin = soIdx >= 0 && args[soIdx + 1] ? args[soIdx + 1] : 'http://localhost:3001';
  const fileArg = args.find((a, i) => a !== '--require-all' && a !== '--server-origin' && args[i - 1] !== '--server-origin');
  if (!fileArg) {
    console.error('usage: grade-transcript.mjs [--server-origin <url>] [--require-all] <capture.jsonl | ->');
    process.exit(2);
  }
  const raw = fileArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(fileArg, 'utf8');
  const capture = parseCapture(raw);
  const result = gradeTranscript(capture, { serverOrigin });
  console.log(formatReport(result));
  process.exit(requireAll && result.failed > 0 ? 1 : 0);
}
