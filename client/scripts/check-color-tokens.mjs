#!/usr/bin/env node
/**
 * check-color-tokens.mjs — the migration completeness gate for feature 006-dark-mode.
 *
 * Scans every `src/**\/*.css` file for raw color literals (hex, rgb()/rgba(),
 * hsl()/hsla(), and CSS named colors used as color *values*) and fails if any
 * appear OUTSIDE the two legal zones:
 *
 *   1. The token-definition region of `src/index.css` (the `:root`,
 *      `:root[data-theme=...]`, and `@media (prefers-color-scheme: ...)` blocks
 *      where the semantic palette literals are *defined*).
 *   2. The canvas allowlist — document-content surfaces that intentionally stay
 *      light "paper" in both themes (D12): EditorCommon.css, the diagram/image
 *      node views, the document-content preview area of VersionPreview.css, and
 *      every `@media print` block (print is theme-independent, D7).
 *
 * Contract: specs/006-dark-mode/contracts/color-tokens.md ("Canvas exclusion set").
 *
 * Usage:
 *   node scripts/check-color-tokens.mjs      # CLI gate — exits 1 if violations
 *   import { findViolations } from './check-color-tokens.mjs'  # for Vitest
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../src');

// --- Canvas allowlist (kept in sync with contracts/color-tokens.md) ----------

// Files that are entirely canvas content and never tokenized (stay light).
const CANVAS_FILES = new Set([
  'EditorCommon.css',   // shared document-content canvas (.editor-common-content / .ProseMirror)
  'DiagramNodeView.css', // rendered-diagram content on the light canvas
  'ImageNodeView.css',   // image content on the light canvas
]);

// The single file where color literals are *legally defined* (the token registry).
const TOKEN_DEF_FILE = 'index.css';

// VersionPreview.css: only the document-content preview area (the light "paper"
// and its inline diff marks) is canvas; the surrounding chrome IS tokenized.
// A block is canvas iff every comma-separated selector part targets the content
// area: `.version-preview`, `.version-preview ins`, `.version-preview del`
// (NOT the `.version-preview-*` chrome classes such as -loading/-authors/-notice).
const VERSION_PREVIEW_FILE = 'VersionPreview.css';
function isVersionPreviewCanvasSelector(header) {
  const parts = header.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((sel) => /^\.version-preview(\s|$|:|\[|>)/.test(sel));
}

// --- Color literal detection -------------------------------------------------

// CSS named colors that count as color values. `transparent`, `currentColor`,
// and CSS-wide keywords (inherit/initial/unset/none/auto) are deliberately
// EXCLUDED — they are theme-agnostic and carry no palette information.
const NAMED_COLORS = new Set([
  'white', 'black', 'red', 'green', 'blue', 'gray', 'grey', 'silver', 'maroon',
  'olive', 'lime', 'aqua', 'teal', 'navy', 'fuchsia', 'purple', 'yellow',
  'orange', 'pink', 'brown', 'gold', 'cyan', 'magenta', 'violet', 'indigo',
  'coral', 'salmon', 'crimson', 'khaki', 'beige', 'ivory', 'tan', 'plum',
  'tomato', 'orchid', 'turquoise', 'lavender', 'gainsboro', 'whitesmoke',
  'lightgray', 'lightgrey', 'darkgray', 'darkgrey', 'dimgray', 'dimgrey',
  'slategray', 'slategrey', 'lightblue', 'darkblue', 'lightgreen', 'darkgreen',
  'lightyellow', 'darkred', 'royalblue', 'steelblue', 'skyblue', 'dodgerblue',
  'firebrick', 'goldenrod', 'chocolate', 'sienna', 'peru', 'wheat', 'linen',
  'snow', 'azure', 'mintcream', 'seagreen', 'forestgreen', 'limegreen',
  'hotpink', 'deeppink', 'tomato', 'darkorange',
]);

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const FUNC_RE = /\b(?:rgba?|hsla?)\s*\(/gi;

/**
 * Find every color literal in a declaration *value* (the text after the first
 * colon). Returns an array of matched literal strings.
 */
function literalsInValue(value) {
  const found = [];
  let m;
  HEX_RE.lastIndex = 0;
  while ((m = HEX_RE.exec(value))) found.push(m[0]);
  FUNC_RE.lastIndex = 0;
  while ((m = FUNC_RE.exec(value))) found.push(m[0].replace(/\s*\($/, '()'));
  // Named colors — whole-word, case-insensitive.
  const wordRe = /[a-zA-Z][a-zA-Z-]*/g;
  while ((m = wordRe.exec(value))) {
    if (NAMED_COLORS.has(m[0].toLowerCase())) found.push(m[0]);
  }
  return found;
}

/** Strip /* ... *\/ comments while preserving newlines for line counting. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, ' ')
  );
}

/**
 * Scan a single CSS file's contents. `relPath` is used for allowlist decisions
 * and reporting. Returns an array of violation objects
 * `{ file, line, literal, selector }`.
 */
export function scanCss(css, relPath) {
  const base = path.basename(relPath);
  if (CANVAS_FILES.has(base)) return []; // whole file is canvas

  const violations = [];
  const clean = stripComments(css);
  const stack = []; // block headers (selectors / at-rules), outermost first

  let buffer = '';
  let line = 1;
  let bufStartLine = 1;

  const inPrint = () => stack.some((h) => /@media[^{]*\bprint\b/i.test(h));

  const isAllowed = () => {
    if (inPrint()) return true; // print is theme-independent (D7)
    if (base === TOKEN_DEF_FILE) {
      // literals are legal inside the token-definition selectors
      return stack.some((h) => /:root|\[data-theme|prefers-color-scheme/i.test(h));
    }
    if (base === VERSION_PREVIEW_FILE) {
      const header = stack[stack.length - 1] || '';
      return isVersionPreviewCanvasSelector(header);
    }
    return false;
  };

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '\n') line++;
    if (ch === '{') {
      stack.push(buffer.trim());
      buffer = '';
      bufStartLine = line;
    } else if (ch === '}') {
      stack.pop();
      buffer = '';
      bufStartLine = line;
    } else if (ch === ';') {
      const decl = buffer.trim();
      const colon = decl.indexOf(':');
      if (colon !== -1) {
        const value = decl.slice(colon + 1);
        const literals = literalsInValue(value);
        if (literals.length && !isAllowed()) {
          for (const literal of literals) {
            violations.push({
              file: relPath,
              line: bufStartLine,
              literal,
              selector: stack[stack.length - 1] || '(top level)',
            });
          }
        }
      }
      buffer = '';
      bufStartLine = line;
    } else {
      if (buffer === '' && ch.trim() !== '') bufStartLine = line;
      buffer += ch;
    }
  }
  return violations;
}

/** Recursively list every .css file under a directory. */
function listCssFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listCssFiles(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

/** Scan the whole client src tree; returns all violations. */
export function findViolations(srcDir = SRC_DIR) {
  const violations = [];
  for (const file of listCssFiles(srcDir)) {
    const rel = path.relative(path.resolve(srcDir, '..'), file);
    violations.push(...scanCss(fs.readFileSync(file, 'utf8'), rel));
  }
  return violations;
}

// --- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log('lint:colors — OK: no disallowed color literals in chrome CSS.');
    process.exit(0);
  }
  console.error(`lint:colors — ${violations.length} disallowed color literal(s) found:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.literal}   in  ${v.selector}`);
  }
  console.error(
    '\nEvery chrome color must use a var(--role) token from ' +
      'contracts/color-tokens.md. Canvas/print/token-def literals are allowlisted.'
  );
  process.exit(1);
}
