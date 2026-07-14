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
// The complete CSS Color Module Level 4 named-color list (148 names, including
// the `gray`/`grey` spelling variants and `rebeccapurple`). Matching is
// case-insensitive and whole-value-token only (see literalsInValue), so a color
// word embedded in a longer identifier (e.g. `sans-serif`) is never matched.
const NAMED_COLORS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque',
  'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood',
  'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk',
  'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray',
  'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta', 'darkolivegreen',
  'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise',
  'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue',
  'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro',
  'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey',
  'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral',
  'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey',
  'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray',
  'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen',
  'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue',
  'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue',
  'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace',
  'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod',
  'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff',
  'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red',
  'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen',
  'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray',
  'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle',
  'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow',
  'yellowgreen',
]);

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const FUNC_RE = /\b(?:rgba?|hsla?)\s*\(/gi;

/**
 * Find every color literal in a declaration *value* (the text after the first
 * colon). Returns an array of matched literal strings.
 */
function literalsInValue(rawValue) {
  // Strip only the `var(--token-name` head of every var() reference — a token
  // NAME may contain a color word (e.g. var(--gray-600), var(--white)) or look
  // hex-ish, and those are legal references, not literals. We deliberately KEEP
  // the fallback body (the `, <fallback>)` tail) so a literal smuggled into a
  // fallback — e.g. `var(--x, #fff)` or `var(--x, rgba(0,0,0,.5))` — is still
  // scanned. A fallback that is itself a token (`var(--x, var(--gray-600))`)
  // has both heads stripped, so its name is not misflagged.
  const value = rawValue.replace(/var\(\s*--[a-zA-Z0-9-]+/g, ' ');
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

  // Anchored allowlist: inside index.css, literals are legal ONLY within a
  // genuine token-definition block — the light `:root`, the dark
  // `:root[data-theme="dark"]`, or the prefers-fallback `:root:not([data-theme])`.
  // Anchoring (^…$) prevents an incidental `:root`/`[data-theme]` substring in
  // some other selector from opening a hole. (The `@media print` reset is
  // covered separately by inPrint().)
  const TOKEN_DEF_SELECTOR = /^:root(\[data-theme="dark"\]|:not\(\[data-theme\]\))?$/;

  const isAllowed = () => {
    if (inPrint()) return true; // forced-light print (D17), theme-independent
    if (base === TOKEN_DEF_FILE) {
      return stack.some((h) => TOKEN_DEF_SELECTOR.test(h));
    }
    return false;
  };

  // Check the just-completed declaration (the text before a `;` or a closing
  // `}`) for disallowed literals. Called at both terminators so a final
  // declaration with no trailing semicolon is not skipped.
  const flushDecl = () => {
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
  };

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '\n') line++;
    if (ch === '{') {
      stack.push(buffer.trim());
      buffer = '';
      bufStartLine = line;
    } else if (ch === '}') {
      // Process any dangling declaration (last one in the block, no trailing
      // `;`) while its block header is still on the stack, then close the block.
      flushDecl();
      stack.pop();
      buffer = '';
      bufStartLine = line;
    } else if (ch === ';') {
      flushDecl();
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
