/**
 * Structure-aware chunker (feature 018 US1, plan D5/RBD-1).
 *
 * Replaces the fixed 6000-char/500-overlap windows with heading-boundary
 * chunks targeting ~600 tokens: documents flatten into blocks tagged with the
 * heading stack in effect (h1→…→hN); a heading forces a new chunk only once
 * the current chunk is at least `headingFillRatio` full (tiny sections pack
 * together); blocks exceeding the target pre-split at sentence boundaries
 * (hard character split only for sentence-less runs); adjacent chunks carry a
 * deterministic trailing-sentence overlap bounded at `overlapRatio` of the
 * target. Tokens are estimated as chars/4 (RBD-1: a consistent cheap
 * heuristic, not a model tokenizer).
 *
 * Re-ported from the reference-only rag-search-v2 branch (never merged),
 * adapted to main: consumes `toStructured()` (server/mcp/yjs/serialization.js)
 * node shapes, and takes every knob from the caller (values resolved via
 * server/search/config.js — no direct env reads here). Pure string/array
 * computation: no time, randomness, or I/O → deterministic by construction
 * (FR-006/SC-001).
 */

const { toStructured } = require('../mcp/yjs/serialization');

const CHARS_PER_TOKEN = 4; // rough heuristic; good enough for sizing (RBD-1)

function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

/**
 * Extract representative plain text from a structured node (and its children).
 * Inline content arrays carry { text, marks } items; block children are joined
 * with newlines so list/table structure stays legible.
 */
function structuredText(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';

  let text = '';
  const content = node.content;
  if (typeof content === 'string') {
    text += content;
  } else if (Array.isArray(content)) {
    text += content.map((it) => (typeof it === 'string' ? it : (it && it.text) || '')).join('');
  }

  if (Array.isArray(node.children)) {
    const childText = node.children.map(structuredText).filter(Boolean).join('\n');
    if (childText) text += (text ? '\n' : '') + childText;
  }

  return text.trim();
}

/**
 * Flatten top-level structured nodes into a list of blocks, each tagged with
 * the heading path (stack of ancestor heading texts) in effect at that point.
 */
function flattenBlocks(nodes) {
  const blocks = [];
  const headingStack = []; // [{ level, text }]

  for (const node of nodes || []) {
    if (node && node.type === 'heading') {
      const level = node.level || 1;
      const text = structuredText(node);
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text });
      blocks.push({ kind: 'heading', text, headingPath: headingStack.map((h) => h.text) });
    } else {
      const text = structuredText(node);
      if (text) {
        blocks.push({ kind: (node && node.type) || 'block', text, headingPath: headingStack.map((h) => h.text) });
      }
    }
  }

  return blocks;
}

/** Split text into sentences (kept simple — good enough for overlap/long-block splitting). */
function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

/** Sentence-split (hard split as last resort) a block larger than the char budget. */
function splitLongText(text, charBudget) {
  if (text.length <= charBudget) return [text];
  const out = [];
  let cur = '';
  for (const sentence of splitSentences(text)) {
    if (sentence.length > charBudget) {
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < sentence.length; i += charBudget) out.push(sentence.slice(i, i + charBudget));
      continue;
    }
    if (cur && cur.length + 1 + sentence.length > charBudget) {
      out.push(cur);
      cur = sentence;
    } else {
      cur = cur ? `${cur} ${sentence}` : sentence;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Take trailing sentences of `text` up to `budget` chars, for cross-chunk
 * overlap. Guaranteed never to exceed `budget`: if even the last sentence is
 * larger than the budget (e.g. a long line with no sentence punctuation), fall
 * back to the last `budget` characters so overlap can't bloat the next chunk.
 */
function trailingOverlap(text, budget) {
  if (budget <= 0) return '';
  const sentences = splitSentences(text);
  let out = '';
  for (let i = sentences.length - 1; i >= 0; i--) {
    const candidate = out ? `${sentences[i]} ${out}` : sentences[i];
    if (candidate.length > budget) {
      if (out) break; // keep what we have; adding this sentence would overflow
      return sentences[i].slice(-budget); // single oversized sentence → take its tail
    }
    out = candidate;
  }
  return out;
}

/**
 * Chunk a structured-node array into overlapping, structure-aware chunks.
 * Every knob comes from the caller (resolved via getSearchConfig upstream).
 *
 * @param {Array} nodes - toStructured() output
 * @param {object} opts
 * @param {number} opts.targetTokens - target chunk size in estimated tokens (default 600)
 * @param {number} opts.headingFillRatio - min fill before a heading forces a flush (default 0.5)
 * @param {number} opts.overlapRatio - trailing-sentence overlap bound as a ratio of target (default 0.12)
 * @returns {Array<{ chunkIndex: number, headingPath: string[], text: string, tokenEstimate: number }>}
 */
function chunkStructured(nodes, { targetTokens = 600, headingFillRatio = 0.5, overlapRatio = 0.12 } = {}) {
  const charTarget = targetTokens * CHARS_PER_TOKEN;
  const overlapBudget = Math.floor(charTarget * overlapRatio);
  const blocks = flattenBlocks(nodes);
  if (blocks.length === 0) return [];

  // Pre-split any block that exceeds the target on its own.
  const units = [];
  for (const block of blocks) {
    const pieces = splitLongText(block.text, charTarget);
    for (const piece of pieces) units.push({ ...block, text: piece });
  }

  const rawChunks = [];
  let curTexts = [];
  let curChars = 0;
  let curHeadingPath = units[0].headingPath;

  const flush = () => {
    if (curTexts.length === 0) return;
    rawChunks.push({ headingPath: curHeadingPath, text: curTexts.join('\n') });
    curTexts = [];
    curChars = 0;
  };

  for (const unit of units) {
    const len = unit.text.length;
    const startsNewSection = unit.kind === 'heading' && curChars >= charTarget * headingFillRatio;
    const wouldOverflow = curChars > 0 && curChars + len + 1 > charTarget;
    if (startsNewSection || wouldOverflow) flush();
    if (curTexts.length === 0) curHeadingPath = unit.headingPath;
    curTexts.push(unit.text);
    curChars += len + 1;
  }
  flush();

  // Apply overlap: prepend trailing sentences of the previous chunk.
  return rawChunks.map((chunk, i) => {
    let text = chunk.text;
    if (i > 0) {
      const overlap = trailingOverlap(rawChunks[i - 1].text, overlapBudget);
      if (overlap) text = `${overlap}\n${text}`;
    }
    return {
      chunkIndex: i,
      headingPath: chunk.headingPath || [],
      text,
      tokenEstimate: estimateTokens(text),
    };
  });
}

/** Convenience wrapper: chunk a Yjs XmlFragment directly. */
function chunkDocument(xmlFragment, opts = {}) {
  return chunkStructured(toStructured(xmlFragment), opts);
}

/**
 * Compose the exact text that gets embedded and chunk-keyword-indexed
 * (DR-1/D3, contracts/chunk-record.md):
 *
 *   header        = [title, ...headingPath].join(' > ')   // title ALWAYS leads
 *   embedded_text = header + '\n' + (preamble ? preamble + '\n\n' : '') + chunkText
 *
 * Applies to every chunk — single-chunk documents and empty trails included.
 * Pure and deterministic given fixed inputs (D13).
 */
function buildEmbeddedText({ title, headingPath, preamble, chunkText }) {
  const header = [title || '', ...(headingPath || [])].join(' > ');
  const preambleBlock = preamble && preamble.trim() ? `${preamble.trim()}\n\n` : '';
  return `${header}\n${preambleBlock}${chunkText}`;
}

module.exports = {
  chunkStructured,
  chunkDocument,
  buildEmbeddedText,
  flattenBlocks,
  structuredText,
  estimateTokens,
  splitLongText,
  trailingOverlap,
  CHARS_PER_TOKEN,
};
