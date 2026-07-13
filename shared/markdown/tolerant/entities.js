/**
 * HTML entity decoding for the tolerant markdown parser (feature 001, CN-4).
 *
 * Supports:
 *   - decimal numeric refs   `&#N;`
 *   - hexadecimal numeric refs `&#xN;` / `&#XN;`
 *   - a curated set of common named entities (CN-4)
 *
 * Per CommonMark: `&#0;`, out-of-range code points, and surrogate-range values
 * decode to the replacement character U+FFFD. Unrecognized *named* entities are
 * returned as literal source text (never dropped — never-lose-content, FR-013).
 *
 * Pure module: no Node built-ins, no external deps (client-safe, FR-014).
 */

const REPLACEMENT = '�';

/**
 * Curated named entities (CN-4). Numeric refs give full coverage for anything
 * outside this table; the full ~2100-entry HTML5 table can be added later
 * without behavior change (unknown named entities are already lossless).
 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™',
  mdash: '—', ndash: '–', hellip: '…',
  laquo: '«', raquo: '»',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  times: '×', deg: '°', middot: '·', bull: '•',
  para: '¶', sect: '§', plusmn: '±', frac12: '½',
  dagger: '†', Dagger: '‡', permil: '‰',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  sup2: '²', sup3: '³', micro: 'µ',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
};

/**
 * Convert a numeric code point to a string, mapping invalid values to U+FFFD.
 */
function codePointToString(cp) {
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
    return REPLACEMENT;
  }
  try {
    return String.fromCodePoint(cp);
  } catch {
    return REPLACEMENT;
  }
}

/**
 * Decode a single entity reference body (the text between `&` and `;`).
 *
 * @param {string} ref - e.g. `amp`, `#65`, `#x41`
 * @returns {string|null} decoded string, or null if unrecognized (caller keeps
 *   the literal source, including the surrounding `&`/`;`).
 */
function decodeEntity(ref) {
  if (ref[0] === '#') {
    const body = ref.slice(1);
    let cp;
    if (body[0] === 'x' || body[0] === 'X') {
      const hex = body.slice(1);
      if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
      cp = parseInt(hex, 16);
    } else {
      if (!/^[0-9]+$/.test(body)) return null;
      cp = parseInt(body, 10);
    }
    return codePointToString(cp);
  }
  return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ref)
    ? NAMED_ENTITIES[ref]
    : null;
}

const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Decode all recognized entity references in `text`. Unrecognized named
 * references are left exactly as written.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  if (!text || text.indexOf('&') === -1) return text;
  return text.replace(ENTITY_RE, (whole, ref) => {
    const decoded = decodeEntity(ref);
    return decoded === null ? whole : decoded;
  });
}

module.exports = { decodeEntities, decodeEntity, NAMED_ENTITIES };
