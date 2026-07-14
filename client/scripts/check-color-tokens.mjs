#!/usr/bin/env node
/**
 * check-color-tokens.mjs — the migration completeness gate for feature 006-dark-mode.
 *
 * Scans every `src/**\/*.css` file for raw color literals (hex, rgb()/rgba(),
 * hsl()/hsla(), and CSS named colors used as color *values*) and fails if any
 * appear OUTSIDE the two legal zones (D5 OVERRIDDEN 2026-07-14 — the canvas now
 * themes dark, so it is NO LONGER allowlisted):
 *
 *   1. The token-definition region of `src/index.css` (the `:root`,
 *      `:root[data-theme=...]`, and `@media (prefers-color-scheme: ...)` blocks
 *      where the semantic palette literals — chrome AND canvas — are *defined*).
 *   2. Every `@media print` block — forced-light print (D17), theme-independent.
 *
 * The constant-light media plate for Mermaid/SVG is a token *reference*
 * (`var(--canvas-media-plate)`), not a literal, so it needs no allowlist entry.
 *
 * Contract: specs/006-dark-mode/contracts/color-tokens.md ("Sanctioned literal exceptions").
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

// --- Sanctioned exceptions (kept in sync with contracts/color-tokens.md) ------

// The single file where color literals are *legally defined* (the token
// registry — chrome AND canvas tokens, plus the forced-light print reset).
const TOKEN_DEF_FILE = 'index.css';

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

  const violations = [];
  const clean = stripComments(css);
  const stack = []; // block headers (selectors / at-rules), outermost first

  let buffer = '';
  let line = 1;
  let bufStartLine = 1;

  const inPrint = () => stack.some((h) => /@media[^{]*\bprint\b/i.test(h));

  const isAllowed = () => {
    if (inPrint()) return true; // forced-light print (D17), theme-independent
    if (base === TOKEN_DEF_FILE) {
      // literals are legal inside the token-definition selectors
      return stack.some((h) => /:root|\[data-theme|prefers-color-scheme/i.test(h));
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
