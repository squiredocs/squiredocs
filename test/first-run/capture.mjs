#!/usr/bin/env node
/**
 * Feature 030 US-foundational (T004, RBD-2, research R1) — structured-capture parser.
 *
 * Parses the client's `claude -p --output-format stream-json --verbose` output
 * (JSONL, one JSON object per line) into a gradable shape:
 *
 *   { prose, events, structured, raw }
 *
 *   - prose:      assistant text blocks concatenated (the coaching the user reads).
 *   - events:     ordered list of { tool, input, result, isError } tool-call records,
 *                 each `tool_use` paired with the `tool_result` sharing its id.
 *   - structured: true iff at least one recognized stream-json message parsed —
 *                 i.e. this really is a structured capture, not flat `--output-format
 *                 text`. Callers fail performable checks CLOSED when structured is
 *                 false OR events is empty (RBD-2): never fall back to prose inference.
 *   - raw:        the untouched input string (for the token-bytes substring scan).
 *
 * Verified against claude v2.1.217 (research.md R1): the stream carries
 *   {type:'system',subtype:'init'}
 *   {type:'assistant',message:{content:[{type:'thinking'|'text'|'tool_use',...}]}}
 *   {type:'user',message:{content:[{type:'tool_result',tool_use_id,content,is_error}]}}
 *   {type:'result',subtype:'success'|'error_*'}
 */

/** Flatten a tool_result / content block value to a plain string. */
function contentToString(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b.text === 'string') return b.text;
        if (b && b.type === 'json' && b.json !== undefined) return JSON.stringify(b.json);
        return b && typeof b === 'object' ? JSON.stringify(b) : String(b ?? '');
      })
      .join('');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return String(content);
}

/**
 * Parse a stream-json capture string into { prose, events, structured, raw }.
 * Robust to interleaved non-JSON noise (blank lines, stray stderr): unparseable
 * lines are ignored; only recognized message types contribute.
 * @param {string} raw
 */
export function parseCapture(raw) {
  const text = String(raw ?? '');
  const lines = text.split(/\r?\n/);

  const proseParts = [];
  const events = [];
  const pending = new Map(); // tool_use_id -> event record (awaiting its result)
  let structured = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;

    if (obj.type === 'system' || obj.type === 'result') {
      structured = true;
      continue;
    }

    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      structured = true;
      for (const block of obj.message.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          proseParts.push(block.text);
        } else if (block.type === 'tool_use') {
          const rec = {
            tool: block.name || '(unnamed)',
            input: block.input ?? {},
            result: null,
            isError: false,
          };
          events.push(rec);
          if (block.id) pending.set(block.id, rec);
        }
      }
      continue;
    }

    if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
      structured = true;
      for (const block of obj.message.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_result') {
          const rec = block.tool_use_id && pending.get(block.tool_use_id);
          const resultStr = contentToString(block.content);
          if (rec) {
            rec.result = resultStr;
            rec.isError = !!block.is_error;
            pending.delete(block.tool_use_id);
          }
        }
      }
      continue;
    }
  }

  return {
    prose: proseParts.join(''),
    events,
    structured,
    raw: text,
  };
}

/**
 * Substring-scan the RAW capture for a secret (the token-bytes assertion, RBD-6).
 * Returns true if the secret appears anywhere in the untouched capture — used to
 * FAIL the token-fallback cell if the token value ever leaks into the transcript.
 * @param {string} raw
 * @param {string} secret
 */
export function captureContainsSecret(raw, secret) {
  if (!secret) return false;
  return String(raw ?? '').includes(secret);
}

// CLI: `node capture.mjs <file.jsonl>` prints a compact summary (debug aid).
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('usage: capture.mjs <stream-json-file | ->');
    process.exit(2);
  }
  const raw = fileArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(fileArg, 'utf8');
  const cap = parseCapture(raw);
  console.log(`structured: ${cap.structured}`);
  console.log(`prose: ${cap.prose.length} chars`);
  console.log(`events: ${cap.events.length}`);
  for (const e of cap.events) {
    console.log(`  - ${e.tool}(${JSON.stringify(e.input).slice(0, 80)})${e.isError ? ' [ERROR]' : ''}`);
  }
}
