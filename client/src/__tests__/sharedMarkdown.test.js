/**
 * Client-safety proof for the shared markdown modules (feature 001, T020,
 * TR-005 / SC-007 / US4 AS-1/AS-2).
 *
 * (a) The shared parser + registry load through the client (Vite/Vitest, jsdom)
 *     toolchain and parse a sample in both modes — proving CJS-under-Vitest
 *     interop for `shared/markdown` and `shared/format-registry` (finding I1).
 * (b) A static module-graph scan from the two entry files asserts every
 *     `require()` specifier is a relative path inside `shared/` or the bare
 *     specifier `prosemirror-model` — no Node built-ins (FR-014).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import the shared modules through the client bundler exactly as M5 paste would.
import * as sharedMarkdown from '../../../shared/markdown/index.js';
import * as sharedRegistry from '../../../shared/format-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED = path.resolve(HERE, '../../../shared');

describe('shared markdown loads under the client toolchain (US4 AS-2)', () => {
  it('exposes markdownToPm + parseInline from the shared entry', () => {
    expect(typeof sharedMarkdown.markdownToPm).toBe('function');
    expect(typeof sharedMarkdown.parseInline).toBe('function');
    expect(typeof sharedRegistry.getEmphasisSpec).toBe('function');
    expect(typeof sharedRegistry.getHtmlWhitelist).toBe('function');
  });

  it('parses a sample in tolerant mode (heading / list / bold / italic)', () => {
    const doc = sharedMarkdown.markdownToPm('# Hi\n\n- [x] done\n\n**bold _nested_**');
    expect(doc.type).toBe('doc');
    const types = doc.content.map((b) => b.type);
    expect(types).toContain('heading');
    // Feature 003 flipped 001's degradation seam: checkbox bullets are real
    // task lists now.
    expect(types).toContain('taskList');

    const marks = [];
    const walk = (n) => {
      if (n.marks) marks.push(...n.marks.map((m) => m.type));
      if (n.content) n.content.forEach(walk);
    };
    walk(doc);
    expect(marks).toContain('bold');
    expect(marks).toContain('italic');
  });

  it('strict mode is callable and returns a valid doc', () => {
    const strict = sharedMarkdown.markdownToPm('# Hi', null, { strict: true });
    expect(strict).toEqual({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hi' }] }] });
  });
});

describe('module-graph is client-safe — no Node built-ins (US4 AS-2, FR-014)', () => {
  const NODE_BUILTINS = new Set([
    'fs', 'path', 'buffer', 'crypto', 'os', 'util', 'stream', 'events', 'http',
    'https', 'net', 'child_process', 'worker_threads', 'zlib', 'url', 'assert',
    'process', 'vm', 'tty', 'dns', 'tls', 'cluster', 'readline', 'querystring',
  ]);
  const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

  function collectRequires(source) {
    const specs = [];
    let m;
    while ((m = REQUIRE_RE.exec(source)) !== null) specs.push(m[1]);
    return specs;
  }

  it('every require() in the shared markdown graph is shared-relative or prosemirror-model', () => {
    const seen = new Set();
    const violations = [];
    const stack = [
      path.join(SHARED, 'markdown/index.js'),
      path.join(SHARED, 'format-registry.js'),
    ];

    while (stack.length > 0) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const source = fs.readFileSync(file, 'utf8');

      for (const spec of collectRequires(source)) {
        if (spec.startsWith('.')) {
          // Relative — must resolve to a file inside shared/
          let resolved = path.resolve(path.dirname(file), spec);
          if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.js`)) resolved = `${resolved}.js`;
          else if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) resolved = path.join(resolved, 'index.js');
          if (!resolved.startsWith(SHARED + path.sep)) {
            violations.push(`${file}: '${spec}' resolves outside shared/ (${resolved})`);
            continue;
          }
          stack.push(resolved);
        } else if (spec === 'prosemirror-model') {
          // The one permitted bare specifier (via shared/prosemirror-schema).
          continue;
        } else if (NODE_BUILTINS.has(spec) || spec.startsWith('node:')) {
          violations.push(`${file}: forbidden Node built-in require('${spec}')`);
        } else {
          violations.push(`${file}: unexpected bare specifier require('${spec}')`);
        }
      }
    }

    expect(violations).toEqual([]);
    // sanity: we actually walked the graph
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });
});
