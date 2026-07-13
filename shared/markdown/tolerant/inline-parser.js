/**
 * Tolerant inline tokenizer (feature 001, T010).
 *
 * Single-pass, left-to-right tokenizer producing ProseMirror text/hardBreak
 * nodes with marks. Implements the CommonMark inline grammar subset the spec
 * requires (FR-003, FR-008…FR-011): code spans, whitelist HTML, autolinks,
 * links, backslash escapes, entity decoding, hard breaks, and emphasis via the
 * CommonMark delimiter-stack algorithm with flanking rules and the intraword
 * `_` restriction.
 *
 * All inline-format knowledge is read from the registry (FR-015): emphasis
 * delimiters from getEmphasisSpec(), the HTML whitelist from getHtmlWhitelist(),
 * and the code-span delimiter from the code mark's registry entry. Only the
 * fixed CommonMark structural syntax (brackets, `<`, `&`, `\`) is literal — the
 * link/code special-casing the contract explicitly permits.
 *
 * Pure module: no Node built-ins (client-safe, FR-014).
 */

const {
  INLINE_MARKS,
  INLINE_NEWLINE,
  STYLE_PROPS,
  cssToAttrs,
  getEmphasisSpec,
  getHtmlWhitelist,
} = require('../../format-registry');
const { decodeEntity } = require('./entities');

// --- Registry-derived tables (built once) ----------------------------------

const EMPHASIS_SPEC = getEmphasisSpec();
const HTML_WHITELIST = getHtmlWhitelist();

// char -> { [length]: markName }
const EMPHASIS_MARK = {};
// chars that follow the intraword-restricted (`_`-style) flanking rule
const INTRAWORD_RESTRICTED = new Set();
for (const s of EMPHASIS_SPEC) {
  (EMPHASIS_MARK[s.char] = EMPHASIS_MARK[s.char] || {})[s.length] = s.markName;
  if (!s.intraword) INTRAWORD_RESTRICTED.add(s.char);
}
const EMPHASIS_CHARS = new Set(Object.keys(EMPHASIS_MARK));

// Code span delimiter + mark, read from the registry entry (verbatim mark is
// the one carrying a custom contentPattern).
const CODE_ENTRY = INLINE_MARKS.find((m) => m.contentPattern) || { name: 'code', wrap: ['`'] };
const CODE_DELIM = CODE_ENTRY.wrap[0];
const CODE_MARK = CODE_ENTRY.name;

// Whitelist tag -> markName
const TAG_MARK = new Map(HTML_WHITELIST.tags.map((t) => [t.tag, t.markName]));

const ESCAPABLE = new Set("!\"#$%&'()*+,-./:;<=>?@[]\\^_`{|}~".split(''));

// --- Small helpers ----------------------------------------------------------

function isWhitespace(ch) {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === INLINE_NEWLINE;
}
const PUNCT_RE = /[!-/:-@[-`{-~]|\p{P}|\p{S}/u;
function isPunct(ch) {
  return ch !== undefined && PUNCT_RE.test(ch);
}
function runLength(src, i, ch) {
  let n = 0;
  while (src[i + n] === ch) n++;
  return n;
}

// --- Linked-list node primitives -------------------------------------------

function makeList() {
  return { head: null, tail: null };
}
function append(list, node) {
  node.prev = list.tail;
  node.next = null;
  if (list.tail) list.tail.next = node;
  else list.head = node;
  list.tail = node;
}
function remove(list, node) {
  if (node.prev) node.prev.next = node.next;
  else list.head = node.next;
  if (node.next) node.next.prev = node.prev;
  else list.tail = node.prev;
}
function insertBefore(list, ref, node) {
  node.next = ref;
  node.prev = ref.prev;
  if (ref.prev) ref.prev.next = node;
  else list.head = node;
  ref.prev = node;
}

// --- Balanced-close precomputation (SC-006 linear-scan guards) --------------
//
// A left-to-right tokenizer that re-scans for a balanced close at every opener
// is O(n^2) when closers exist ahead but never balance (e.g.
// '['.repeat(65536)+'](x)', or '<span ...>'.repeat(k)+'</span>'). We instead
// pair every opener with its balanced closer in a single O(n) stack pass, so
// each opener's lookup is O(1) (F2). Escaped `\[ \] \( \)` are skipped so the
// pairing matches the tokenizer's own escape handling.

function computeDelimBalance(src, openCh, closeCh) {
  const map = new Map();
  const stack = [];
  const n = src.length;
  for (let j = 0; j < n; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === openCh) stack.push(j);
    else if (c === closeCh && stack.length) map.set(stack.pop(), j);
  }
  return map;
}

// Map each `<tag>` opener position to its balanced `</tag>` position.
function computeStringBalance(src, openStr, closeStr) {
  const map = new Map();
  const stack = [];
  const n = src.length;
  for (let j = 0; j < n;) {
    if (src.startsWith(closeStr, j)) {
      if (stack.length) map.set(stack.pop(), j);
      j += closeStr.length;
    } else if (src.startsWith(openStr, j)) {
      stack.push(j);
      j += openStr.length;
    } else {
      j++;
    }
  }
  return map;
}

// Map each `<span[\s>]` opener position to its balanced `</span>` position.
// Mirrors the (case-insensitive) open/close detection the old scanner used.
function computeSpanBalance(src) {
  const lower = src.toLowerCase();
  const map = new Map();
  const stack = [];
  const n = src.length;
  for (let j = 0; j < n;) {
    if (lower.startsWith('</span>', j)) {
      if (stack.length) map.set(stack.pop(), j);
      j += 7;
    } else if (lower.startsWith('<span', j)) {
      const c = lower[j + 5];
      if (c === '>' || (c !== undefined && /\s/.test(c))) {
        stack.push(j);
        j += 5;
      } else {
        j++;
      }
    } else {
      j++;
    }
  }
  return map;
}

// --- Emphasis processing (CommonMark delimiter stack) -----------------------

function makeDelim(src, i, ch, len) {
  const before = i > 0 ? src[i - 1] : ' ';
  const after = src[i + len] !== undefined ? src[i + len] : ' ';
  const beforeWS = isWhitespace(before);
  const afterWS = isWhitespace(after);
  const beforePunct = isPunct(before);
  const afterPunct = isPunct(after);
  const leftFlank = !afterWS && (!afterPunct || beforeWS || beforePunct);
  const rightFlank = !beforeWS && (!beforePunct || afterWS || afterPunct);
  let open;
  let close;
  if (INTRAWORD_RESTRICTED.has(ch)) {
    open = leftFlank && (!rightFlank || beforePunct);
    close = rightFlank && (!leftFlank || afterPunct);
  } else {
    open = leftFlank;
    close = rightFlank;
  }
  return { kind: 'delim', char: ch, chars: ch.repeat(len), len, origLen: len, open, close };
}

function wrapEmphasis(list, opener, closer, mark, useLen) {
  opener.chars = opener.chars.slice(0, opener.chars.length - useLen);
  opener.len = opener.chars.length;
  closer.chars = closer.chars.slice(useLen);
  closer.len = closer.chars.length;

  const children = [];
  let cur = opener.next;
  while (cur && cur !== closer) {
    const nxt = cur.next;
    remove(list, cur);
    cur.prev = null;
    cur.next = null;
    children.push(cur);
    cur = nxt;
  }
  const markNode = { kind: 'wrap', mark, children, prev: null, next: null };
  insertBefore(list, closer, markNode);
}

function processEmphasis(list, delims) {
  const openersBottom = {};
  let closerIdx = 0;
  while (closerIdx < delims.length) {
    const closer = delims[closerIdx];
    if (!closer.close || closer.len === 0) {
      closerIdx++;
      continue;
    }
    const ch = closer.char;
    const key = ch + (closer.open ? '1' : '0') + (closer.origLen % 3);
    const bottom = key in openersBottom ? openersBottom[key] : -1;

    let openerIdx = closerIdx - 1;
    let found = false;
    while (openerIdx > bottom) {
      const opener = delims[openerIdx];
      if (opener.open && opener.len > 0 && opener.char === ch) {
        const oddMatch =
          (opener.close || closer.open) &&
          (opener.origLen + closer.origLen) % 3 === 0 &&
          !(opener.origLen % 3 === 0 && closer.origLen % 3 === 0);
        if (!oddMatch) {
          found = true;
          break;
        }
      }
      openerIdx--;
    }

    if (!found) {
      openersBottom[key] = closerIdx - 1;
      closerIdx++;
      continue;
    }

    const opener = delims[openerIdx];
    const map = EMPHASIS_MARK[ch];
    let useLen;
    if (opener.len >= 2 && closer.len >= 2 && map[2]) useLen = 2;
    else if (map[1]) useLen = 1;
    else {
      openersBottom[key] = closerIdx - 1;
      closerIdx++;
      continue;
    }

    wrapEmphasis(list, opener.node, closer.node, { type: map[useLen] }, useLen);

    delims.splice(openerIdx + 1, closerIdx - openerIdx - 1);
    closerIdx = openerIdx + 1;

    if (delims[closerIdx].len === 0) {
      remove(list, delims[closerIdx].node);
      delims.splice(closerIdx, 1);
    }
    if (delims[openerIdx].len === 0) {
      remove(list, delims[openerIdx].node);
      delims.splice(openerIdx, 1);
      closerIdx--;
    }
  }
}

// --- Tokenizer --------------------------------------------------------------

function trimTrailingUrlPunct(url) {
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1];
    if ('?!.,:*_~'.includes(c)) {
      end--;
    } else if (c === ')') {
      const slice = url.slice(0, end);
      const opens = (slice.match(/\(/g) || []).length;
      const closes = (slice.match(/\)/g) || []).length;
      if (closes > opens) end--;
      else break;
    } else {
      break;
    }
  }
  return url.slice(0, end);
}

/**
 * Parse an inline source string into a flat array of intermediate nodes
 * (text / delim / wrap / hardBreak). Recurses for link/HTML content.
 */
function parseToTree(src) {
  const list = makeList();
  const delims = [];
  let buf = '';
  const n = src.length;
  let i = 0;

  // Balanced open→close maps, precomputed once so every opener's lookup is O(1)
  // (prevents O(n^2) blowup on bracket/paren/tag floods, SC-006/F2). The string
  // is immutable within this call.
  const bracketBalance = computeDelimBalance(src, '[', ']');
  const parenBalance = computeDelimBalance(src, '(', ')');
  const spanBalance = computeSpanBalance(src);
  const tagBalance = new Map();
  for (const tag of TAG_MARK.keys()) tagBalance.set(tag, computeStringBalance(src, `<${tag}>`, `</${tag}>`));

  function flush() {
    if (buf) {
      append(list, { kind: 'text', value: buf });
      buf = '';
    }
  }
  function pushWrap(mark, childrenArr) {
    flush();
    append(list, { kind: 'wrap', mark, children: childrenArr });
  }

  // Try whitelist HTML / autolink / <br> at a '<'. Returns next index or -1.
  function tryAngle() {
    const rest = src.slice(i);

    // Hard break: <br>, <br/>, <br />
    const brMatch = /^<br\s*\/?>/i.exec(rest);
    if (brMatch) {
      flush();
      append(list, { kind: 'hardBreak' });
      return i + brMatch[0].length;
    }

    // <span style="...">...</span>
    const spanMatch = /^<span style="([^"]*)">/i.exec(rest);
    if (spanMatch) {
      const closeIdx = spanBalance.has(i) ? spanBalance.get(i) : -1;
      if (closeIdx !== -1) {
        const contentStart = i + spanMatch[0].length;
        const attrs = cssToAttrs(spanMatch[1]);
        const recognized = STYLE_PROPS.some((p) => attrs[p.attr] !== undefined);
        if (recognized) {
          const inner = parseToTree(src.slice(contentStart, closeIdx));
          pushWrap({ type: 'textStyle', attrs }, inner);
          return closeIdx + '</span>'.length;
        }
        // Zero recognized props → literal source, tags included (CN-6).
        buf += src.slice(i, closeIdx + '</span>'.length);
        return closeIdx + '</span>'.length;
      }
      return -1;
    }

    // Whitelist mark tags: <u>, <mark>, <sub>, <sup>
    const tagMatch = /^<([a-zA-Z][a-zA-Z0-9]*)>/.exec(rest);
    if (tagMatch && TAG_MARK.has(tagMatch[1])) {
      const tag = tagMatch[1];
      const balance = tagBalance.get(tag);
      const closeIdx = balance && balance.has(i) ? balance.get(i) : -1;
      if (closeIdx !== -1) {
        const contentStart = i + tagMatch[0].length;
        const inner = parseToTree(src.slice(contentStart, closeIdx));
        pushWrap({ type: TAG_MARK.get(tag) }, inner);
        return closeIdx + `</${tag}>`.length;
      }
      return -1;
    }

    // Angle-bracket autolink: absolute URI
    const uriMatch = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(rest);
    if (uriMatch) {
      pushWrap({ type: 'link', attrs: { href: uriMatch[1] } }, [{ kind: 'text', value: uriMatch[1] }]);
      return i + uriMatch[0].length;
    }
    // Angle-bracket autolink: email → mailto
    const emailMatch = /^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(rest);
    if (emailMatch) {
      pushWrap({ type: 'link', attrs: { href: `mailto:${emailMatch[1]}` } }, [{ kind: 'text', value: emailMatch[1] }]);
      return i + emailMatch[0].length;
    }

    return -1;
  }

  // Link [text](href). Returns next index or -1.
  function tryLink() {
    // Balanced `]` for the `[` at i, and it must be followed by `(...)`.
    const close = bracketBalance.has(i) ? bracketBalance.get(i) : -1;
    if (close === -1 || src[close + 1] !== '(') return -1;
    const openParen = close + 1;
    const closeParen = parenBalance.has(openParen) ? parenBalance.get(openParen) : -1;
    if (closeParen === -1) return -1;
    const textSrc = src.slice(i + 1, close);
    // Destination text, unescaping backslashes (matches the strict dialect).
    let href = '';
    for (let k = openParen + 1; k < closeParen; k++) {
      if (src[k] === '\\') {
        href += src[k + 1] !== undefined ? src[k + 1] : '';
        k++;
      } else {
        href += src[k];
      }
    }
    pushWrap({ type: 'link', attrs: { href: href.trim() } }, parseToTree(textSrc));
    return closeParen + 1;
  }

  // Bare autolink (GFM www/url). Returns next index or -1.
  function tryBareAutolink() {
    const before = i > 0 ? src[i - 1] : undefined;
    if (before !== undefined && /[A-Za-z0-9]/.test(before)) return -1;
    const m = /^(https?:\/\/|www\.)[^\s<]*/i.exec(src.slice(i));
    if (!m) return -1;
    let url = trimTrailingUrlPunct(m[0]);
    if (!/\./.test(url) || url.length <= m[1].length) return -1;
    const href = /^www\./i.test(url) ? `http://${url}` : url;
    pushWrap({ type: 'link', attrs: { href } }, [{ kind: 'text', value: url }]);
    return i + url.length;
  }

  while (i < n) {
    const ch = src[i];

    if (ch === '\\') {
      const next = src[i + 1];
      if (next === '\n') {
        flush();
        append(list, { kind: 'hardBreak' });
        i += 2;
        continue;
      }
      if (next !== undefined && ESCAPABLE.has(next)) {
        buf += next;
        i += 2;
        continue;
      }
      buf += '\\';
      i += 1;
      continue;
    }

    if (ch === CODE_DELIM) {
      const run = runLength(src, i, CODE_DELIM);
      // find a closing run of exactly `run` backticks
      let j = i + run;
      let closeAt = -1;
      while (j < n) {
        if (src[j] === CODE_DELIM) {
          const r = runLength(src, j, CODE_DELIM);
          if (r === run) {
            closeAt = j;
            break;
          }
          j += r;
        } else {
          j++;
        }
      }
      if (closeAt !== -1) {
        let code = src.slice(i + run, closeAt).replace(/\r?\n/g, ' ');
        if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) {
          code = code.slice(1, -1);
        }
        flush();
        append(list, { kind: 'wrap', mark: { type: CODE_MARK }, children: [{ kind: 'text', value: code }] });
        i = closeAt + run;
        continue;
      }
      buf += CODE_DELIM.repeat(run);
      i += run;
      continue;
    }

    if (ch === '<') {
      const next = tryAngle();
      if (next !== -1) {
        i = next;
        continue;
      }
      buf += '<';
      i += 1;
      continue;
    }

    if (ch === '&') {
      const m = /^&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/.exec(src.slice(i));
      if (m) {
        const decoded = decodeEntity(m[1]);
        if (decoded !== null) {
          buf += decoded;
          i += m[0].length;
          continue;
        }
      }
      buf += '&';
      i += 1;
      continue;
    }

    if (ch === '[') {
      const next = tryLink();
      if (next !== -1) {
        i = next;
        continue;
      }
      buf += '[';
      i += 1;
      continue;
    }

    if ((ch === 'h' || ch === 'H' || ch === 'w' || ch === 'W')) {
      const next = tryBareAutolink();
      if (next !== -1) {
        i = next;
        continue;
      }
    }

    if (ch === '\n') {
      const trail = /( +)$/.exec(buf);
      if (trail && trail[1].length >= 2) {
        buf = buf.slice(0, buf.length - trail[1].length);
        flush();
        append(list, { kind: 'hardBreak' });
      } else {
        buf = buf.replace(/ +$/, '') + ' ';
        // swallow leading spaces on the continuation line
        while (src[i + 1] === ' ' || src[i + 1] === '\t') i++;
      }
      i += 1;
      continue;
    }

    if (EMPHASIS_CHARS.has(ch)) {
      const run = runLength(src, i, ch);
      const delim = makeDelim(src, i, ch, run);
      flush();
      delim.node = delim;
      append(list, delim);
      delims.push(delim);
      i += run;
      continue;
    }

    buf += ch;
    i += 1;
  }
  flush();

  processEmphasis(list, delims);

  // Linked list → array
  const out = [];
  for (let node = list.head; node; node = node.next) out.push(node);
  return out;
}

// --- Flatten to ProseMirror nodes ------------------------------------------

function makeTextNode(value, marks, diffMark) {
  const node = { type: 'text', text: value.replaceAll(INLINE_NEWLINE, '\n') };
  // Deduplicate marks: a ProseMirror node holds a mark SET, so nested same-type
  // emphasis (e.g. `**x* *y*` producing italic-in-italic) must not list the
  // mark twice. Keep first occurrence; distinguish by type + attrs.
  const all = [];
  const seen = new Set();
  for (const m of marks) {
    const key = m.attrs ? `${m.type}:${JSON.stringify(m.attrs)}` : m.type;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(m);
  }
  if (diffMark) all.push({ type: diffMark });
  if (all.length > 0) node.marks = all;
  return node;
}

function flatten(nodes, marks, diffMark, out) {
  for (const node of nodes) {
    if (node.kind === 'text') {
      if (node.value) out.push(makeTextNode(node.value, marks, diffMark));
    } else if (node.kind === 'delim') {
      if (node.chars) out.push(makeTextNode(node.chars, marks, diffMark));
    } else if (node.kind === 'hardBreak') {
      out.push({ type: 'hardBreak' });
    } else if (node.kind === 'wrap') {
      flatten(node.children, [...marks, node.mark], diffMark, out);
    }
  }
  return out;
}

/** Merge adjacent text nodes that carry identical marks. */
function mergeText(nodes) {
  const out = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (
      node.type === 'text' &&
      prev &&
      prev.type === 'text' &&
      JSON.stringify(prev.marks) === JSON.stringify(node.marks)
    ) {
      prev.text += node.text;
    } else {
      out.push(node);
    }
  }
  return out;
}

/**
 * Parse inline markdown into an array of ProseMirror inline nodes.
 *
 * @param {string} text
 * @param {string|null} diffMark
 * @returns {Array<object>}
 */
function parseInlineTolerant(text, diffMark = null) {
  if (!text) return [];
  const tree = parseToTree(text);
  const flat = flatten(tree, [], diffMark, []);
  return mergeText(flat);
}

module.exports = { parseInlineTolerant };
