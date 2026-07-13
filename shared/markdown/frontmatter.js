/**
 * Frontmatter strip/preserve (feature 003, FR-015/FR-016).
 *
 * `parseFrontmatter(markdown)` implements the recognition + strip/preserve
 * contract consumed by features 002 (import) and 004 (sync):
 * specs/003-portable-export/contracts/frontmatter-squire-block.md.
 *
 * The main parser entry (`shared/markdown/index.js`) stays deliberately
 * frontmatter-UNAWARE (001 owns its grammar): surfaces that accept whole
 * files call `parseFrontmatter` first and hand `body` to `markdownToPm`.
 * This module is also deliberately NOT re-exported from the parser index —
 * it requires `js-yaml` (pure JS, no Node built-ins, but a bare specifier),
 * and the index's module graph is pinned client-safe/self-contained by
 * client/src/__tests__/sharedMarkdown.test.js. Consumers import it directly:
 * `require('shared/markdown/frontmatter')`.
 *
 * Trust boundary (Constitution V): frontmatter is untrusted input. YAML is
 * loaded with js-yaml's JSON_SCHEMA — plain data only, no custom types, no
 * evaluation. `squire:` metadata is advisory; it confers no access and
 * triggers no privileged behavior here. Any recognition failure degrades the
 * whole input to ordinary content (never an error, never content loss).
 */

const yaml = require('js-yaml');

/**
 * Size cap for a recognized frontmatter block, opening fence through closing
 * fence inclusive (RD-9). Oversized blocks are ordinary content.
 */
const MAX_FRONTMATTER_BYTES = 64 * 1024;

/** A fence line is exactly `---` (tolerating a CR from CRLF sources). */
function isFence(line) {
  return /^---\r?$/.test(line);
}

/**
 * UTF-8 byte length with a cheap upper-bound shortcut: UTF-8 bytes per code
 * point >= UTF-16 code units per code point, so a string longer than the cap
 * in code units is guaranteed over the cap in bytes without encoding.
 */
function overByteCap(str, cap) {
  if (str.length > cap) return true;
  return new TextEncoder().encode(str).length > cap;
}

/**
 * Parse (and strip) a leading YAML frontmatter block.
 *
 * @param {string} markdown - Untrusted file content.
 * @returns {{ body: string, squire: object|null, foreignRaw: string|null }}
 *   - body: document content without the frontmatter block (the whole input
 *     when no valid block is recognized).
 *   - squire: parsed value of the top-level `squire:` key (plain data,
 *     advisory only), or null.
 *   - foreignRaw: the block's raw inner lines minus the `squire:` key's
 *     lines, bytes and order preserved (RD-4), or null if nothing remains.
 */
function parseFrontmatter(markdown) {
  const raw = String(markdown == null ? '' : markdown);
  // BOM-leniency: strip a single leading U+FEFF only.
  const src = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const asContent = { body: src, squire: null, foreignRaw: null };

  const lines = src.split('\n');
  // 1. Recognition only at line 1.
  if (lines.length < 2 || !isFence(lines[0])) return asContent;

  // 2. A closing fence must exist (a later line that is exactly `---`).
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isFence(lines[i])) {
      close = i;
      break;
    }
  }
  if (close === -1) return asContent;

  // 3. Size cap, fences inclusive (RD-9).
  const span = lines.slice(0, close + 1).join('\n');
  if (overByteCap(span, MAX_FRONTMATTER_BYTES)) return asContent;

  // 4. Must parse (safely, plain data only) to a YAML mapping.
  const inner = lines.slice(1, close);
  const innerText = inner.join('\n');
  let parsed;
  try {
    parsed = yaml.load(innerText, { schema: yaml.JSON_SCHEMA });
  } catch {
    return asContent;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return asContent;
  }

  // Body: everything after the closing fence, one leading blank line removed.
  let bodyLines = lines.slice(close + 1);
  if (bodyLines.length > 0 && bodyLines[0].trim() === '') {
    bodyLines = bodyLines.slice(1);
  }
  const body = bodyLines.join('\n');

  const hasSquire = Object.prototype.hasOwnProperty.call(parsed, 'squire');
  if (!hasSquire) {
    return { body, squire: null, foreignRaw: innerText.trim() === '' ? null : innerText };
  }

  // Excise the squire: key's raw lines. Top-level keys sit at column 0 in a
  // valid mapping, so the span is the `squire:` line through the last
  // following line that is indented or blank. If the raw scan cannot be
  // validated against the parsed key set, treat the WHOLE block as foreign
  // (conservative: foreign keys are never corrupted).
  const startIdx = inner.findIndex((l) => /^squire:(\s|\r?$)/.test(l));
  let foreignLines = null;
  let valid = startIdx !== -1;
  if (valid) {
    let end = startIdx + 1;
    while (end < inner.length && (/^[ \t]/.test(inner[end]) || inner[end].trim() === '')) {
      end++;
    }
    foreignLines = [...inner.slice(0, startIdx), ...inner.slice(end)];
    try {
      const foreignText = foreignLines.join('\n');
      const reparsed = foreignText.trim() === ''
        ? {}
        : yaml.load(foreignText, { schema: yaml.JSON_SCHEMA });
      const foreignParsed = reparsed === null ? {} : reparsed;
      if (typeof foreignParsed !== 'object' || Array.isArray(foreignParsed)) {
        valid = false;
      } else {
        const expected = Object.keys(parsed).filter((k) => k !== 'squire').sort();
        const got = Object.keys(foreignParsed).sort();
        valid = expected.length === got.length && expected.every((k, i) => k === got[i]);
      }
    } catch {
      valid = false;
    }
  }

  if (!valid) {
    return { body, squire: null, foreignRaw: innerText };
  }

  const foreignRaw = foreignLines.join('\n');
  return {
    body,
    squire: parsed.squire == null ? null : parsed.squire,
    foreignRaw: foreignRaw.trim() === '' ? null : foreignRaw,
  };
}

module.exports = { parseFrontmatter, MAX_FRONTMATTER_BYTES };
