/**
 * Defensive frontmatter consumption for markdown import (feature 002).
 *
 * Detects a leading `---` YAML block at the absolute start of the input,
 * reads the `squire:` mapping's recognized fields (this feature reads only
 * `title`), and re-emits every non-`squire:` top-level entry as a leading
 * fenced `yaml` code block so no content is lost (CN-5). Malformed YAML is
 * never an error: the whole block is treated as ordinary markdown content
 * (FR-006/FR-007). This module NEVER throws on any input shape.
 *
 * The `squire:` field contract is owned by feature 003; this consumer is
 * deliberately minimal and tolerant: unknown `squire:` keys are ignored, and
 * no YAML library is used (research R8) — a small structural scan covers the
 * subset frontmatter actually needs, and anything it cannot confidently read
 * is classified malformed-as-content rather than guessed at.
 */

/**
 * Strip a UTF-8 BOM and normalize CRLF / lone CR to LF.
 * @param {string} text
 * @returns {string}
 */
function normalizeMarkdown(text) {
  const src = typeof text === 'string' ? text : String(text == null ? '' : text);
  return src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

const TOP_LEVEL_KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ \t](.*))?$/;

/**
 * Check that any flow-style brackets/braces opened in a scalar value are
 * balanced across the entry's lines. `squire: [unclosed` must classify the
 * whole block as malformed, not silently parse.
 */
function flowBalanced(lines) {
  let square = 0;
  let curly = 0;
  for (const line of lines) {
    // Ignore everything after a comment marker preceded by whitespace/BOL.
    const uncommented = line.replace(/(^|\s)#.*$/, '$1');
    for (const ch of uncommented) {
      if (ch === '[') square++;
      else if (ch === ']') square--;
      else if (ch === '{') curly++;
      else if (ch === '}') curly--;
      if (square < 0 || curly < 0) return false;
    }
  }
  return square === 0 && curly === 0;
}

/**
 * Parse the frontmatter block's lines into top-level entries.
 * Returns null when the structure is not confidently parseable (⇒ malformed).
 * @param {string[]} lines
 * @returns {Array<{ key: string, lines: string[] }>|null}
 */
function parseTopLevelEntries(lines) {
  const entries = [];
  let current = null;
  for (const line of lines) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      // Blank / comment lines attach to the current entry (kept verbatim in
      // residue) or are ignored before the first key.
      if (current) current.lines.push(line);
      continue;
    }
    if (/^[ \t]/.test(line) || /^-\s/.test(line) || line === '-') {
      // Continuation (nested mapping, list item, folded scalar…) — must belong
      // to an existing entry; a leading continuation is not valid YAML shape.
      if (!current) return null;
      current.lines.push(line);
      continue;
    }
    const m = line.match(TOP_LEVEL_KEY);
    if (!m) return null; // top-level line that is not `key:` — not a mapping
    current = { key: m[1], lines: [line] };
    entries.push(current);
  }
  for (const entry of entries) {
    if (!flowBalanced(entry.lines)) return null;
  }
  return entries;
}

/** Strip matching surrounding quotes from a scalar value. */
function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Read recognized scalar fields from a `squire:` entry's nested block.
 * Unknown keys and unreadable shapes are ignored silently (FR-006).
 * @param {string[]} entryLines - the entry's lines, `squire:` line first
 * @returns {{ title?: string }}
 */
function readSquireFields(entryLines) {
  const fields = {};
  for (const line of entryLines.slice(1)) {
    const m = line.match(/^[ \t]+([A-Za-z0-9_][A-Za-z0-9_.-]*):[ \t]+(.+?)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (key === 'title') {
      const value = unquote(m[2]);
      if (value) fields.title = value;
    }
    // Unknown squire keys: ignored without error (contract owned by 003).
  }
  return fields;
}

/**
 * Wrap residue YAML in a fenced code block whose fence is guaranteed longer
 * than any backtick run inside the residue (so the block can't be broken out
 * of by hostile frontmatter content).
 */
function fenceYaml(residue) {
  let longest = 0;
  for (const m of residue.matchAll(/`+/g)) {
    if (m[0].length > longest) longest = m[0].length;
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}yaml\n${residue}\n${fence}`;
}

/**
 * Detect and consume a leading frontmatter block.
 *
 * @param {string} markdown - raw untrusted markdown (any line endings, BOM ok)
 * @returns {{
 *   content: string,            // body markdown to parse (residue block prepended)
 *   body: string,               // body without the residue block
 *   squire: { title?: string }, // recognized squire fields (empty when none)
 *   residue: string|null,       // non-squire frontmatter re-serialized, or null
 *   raw: string|null,           // the full `---…---` block when syntactically present
 *   hadFrontmatter: boolean,    // a well-formed block was consumed
 *   malformed: boolean          // a syntactic block existed but wasn't parseable YAML
 * }}
 */
function consumeFrontmatter(markdown) {
  const normalized = normalizeMarkdown(markdown);
  const result = {
    content: normalized,
    body: normalized,
    squire: {},
    residue: null,
    raw: null,
    hadFrontmatter: false,
    malformed: false,
  };

  try {
    if (!/^---[ \t]*\n/.test(normalized)) return result;

    const lines = normalized.split('\n');
    let closeIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (/^---[ \t]*$/.test(lines[i])) {
        closeIndex = i;
        break;
      }
    }
    if (closeIndex === -1) return result; // no closing delimiter — not frontmatter

    const blockLines = lines.slice(1, closeIndex);
    const raw = lines.slice(0, closeIndex + 1).join('\n');
    const body = lines.slice(closeIndex + 1).join('\n').replace(/^\n+/, '');
    result.raw = raw;

    const entries = parseTopLevelEntries(blockLines);
    if (entries === null) {
      // Malformed YAML: the whole block is ordinary content (FR-007).
      result.malformed = true;
      return result;
    }

    const squireEntry = entries.find((e) => e.key === 'squire');
    const residueEntries = entries.filter((e) => e.key !== 'squire');

    result.hadFrontmatter = true;
    result.body = body;
    if (squireEntry) {
      result.squire = readSquireFields(squireEntry.lines);
    }
    if (residueEntries.length > 0) {
      const residue = residueEntries
        .map((e) => e.lines.join('\n'))
        .join('\n')
        .replace(/\n+$/, '');
      result.residue = residue;
      result.content = body
        ? `${fenceYaml(residue)}\n\n${body}`
        : `${fenceYaml(residue)}\n`;
    } else {
      result.content = body;
    }
    return result;
  } catch (err) {
    // Never throw on frontmatter — fall back to input-as-content (FR-006/007).
    return {
      content: normalized,
      body: normalized,
      squire: {},
      residue: null,
      raw: null,
      hadFrontmatter: false,
      malformed: true,
    };
  }
}

module.exports = { normalizeMarkdown, consumeFrontmatter };
