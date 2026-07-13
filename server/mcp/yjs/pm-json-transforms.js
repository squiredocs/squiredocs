/**
 * Pure PM-JSON transforms shared by the import module and the sandbox
 * `fromMarkdown` helper (feature 002). These operate ONLY on ProseMirror JSON
 * (no Yjs, no Node built-ins), so they bundle cleanly into the isolate and
 * keep a single implementation of the import-time security/normalization
 * grammar (FR-001): link-href sanitation, image-node reconstruction from the
 * parser's canonical degradation, and `data:` rejection.
 *
 * The shared markdown parser (feature 001) owns markdown grammar; these
 * transforms own the import-time PM-JSON post-processing that every surface
 * needs identically.
 */

/** Strip C0 controls / whitespace, then read a URL scheme (lowercased). */
function schemeOf(href) {
  if (typeof href !== 'string') return null;
  // Browsers ignore control and whitespace characters when parsing a scheme;
  // strip them everywhere so `jav\tascript:` can't sneak through.
  const cleaned = href.replace(/[\u0000-\u0020\u007f\s]+/g, '');
  const m = cleaned.match(/^([a-z][a-z0-9+.-]*):/i);
  return m ? m[1].toLowerCase() : null;
}

/** Cleaned href (control/whitespace-stripped) for prefix checks. */
function cleanedHref(href) {
  return typeof href === 'string' ? href.replace(/[\u0000-\u0020\u007f\s]+/g, '') : '';
}

const ALLOWED_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);

/** Whether a link href passes the import protocol allowlist (FR-022, CN-9). */
function isAllowedLinkHref(href) {
  const scheme = schemeOf(href);
  if (scheme) return ALLOWED_LINK_SCHEMES.has(scheme);
  // Scheme-less: app-relative paths and fragments are allowed. `//host` is
  // scheme-relative http(s), which the allowlist permits anyway.
  const cleaned = cleanedHref(href);
  return cleaned.startsWith('/') || cleaned.startsWith('#');
}

/**
 * Drop link marks whose href protocol is outside the allowlist; keep the text
 * (FR-022). Mutates and returns the PM JSON.
 */
function sanitizeLinkMarks(pmJson) {
  function walk(node) {
    if (Array.isArray(node.marks)) {
      node.marks = node.marks.filter((mark) => {
        if (!mark || mark.type !== 'link') return true;
        return isAllowedLinkHref(mark.attrs && mark.attrs.href);
      });
      if (node.marks.length === 0) delete node.marks;
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
    return node;
  }
  return walk(pmJson);
}

/** src schemes reconstruction recognizes as image sources. */
function isImageSrcCandidate(href) {
  const scheme = schemeOf(href);
  if (scheme) return scheme === 'http' || scheme === 'https' || scheme === 'data';
  return cleanedHref(href).startsWith('/');
}

function linkHrefOf(node) {
  if (!node || node.type !== 'text' || !Array.isArray(node.marks)) return null;
  const link = node.marks.find((m) => m && m.type === 'link');
  return link && link.attrs && typeof link.attrs.href === 'string' ? link.attrs.href : null;
}

/**
 * Rebuild block-level image nodes from the parser's canonical image
 * degradation: a text run ending in `!` immediately followed by link-marked
 * text (feature 001 emits `![alt](src)` as literal `!` + a link mark on the
 * alt, because image nodes are 002 scope). Top-level paragraphs only — the
 * schema's image node is a block atom, so nested image markdown stays in its
 * degraded link form (which is exactly FR-018's degradation shape). Mutates
 * and returns the PM JSON.
 */
function reconstructImages(pmJson) {
  if (!pmJson || !Array.isArray(pmJson.content)) return pmJson;

  const newBlocks = [];
  for (const block of pmJson.content) {
    if (!block || block.type !== 'paragraph' || !Array.isArray(block.content)) {
      newBlocks.push(block);
      continue;
    }

    const segments = []; // alternating: arrays of inline nodes / image nodes
    let current = [];
    const inline = block.content;
    let i = 0;
    while (i < inline.length) {
      const node = inline[i];
      const isBangCarrier =
        node && node.type === 'text' && typeof node.text === 'string' &&
        node.text.endsWith('!') && !linkHrefOf(node);
      const nextHref = i + 1 < inline.length ? linkHrefOf(inline[i + 1]) : null;

      if (isBangCarrier && nextHref && isImageSrcCandidate(nextHref)) {
        // Collect the whole linked run (formatted alt text spans several nodes).
        let j = i + 1;
        const altParts = [];
        while (j < inline.length && linkHrefOf(inline[j]) === nextHref) {
          altParts.push(inline[j].text || '');
          j++;
        }
        // Keep any text before the '!' as ordinary inline content.
        const before = node.text.slice(0, -1);
        if (before) current.push({ ...node, text: before });
        if (current.length > 0) {
          segments.push({ kind: 'inline', nodes: current });
          current = [];
        }
        segments.push({
          kind: 'image',
          node: { type: 'image', attrs: { src: nextHref, alt: altParts.join('') || null } },
        });
        i = j;
      } else {
        current.push(node);
        i++;
      }
    }
    if (current.length > 0) segments.push({ kind: 'inline', nodes: current });

    if (!segments.some((s) => s.kind === 'image')) {
      newBlocks.push(block);
      continue;
    }
    for (const segment of segments) {
      if (segment.kind === 'image') {
        newBlocks.push(segment.node);
      } else {
        newBlocks.push({ ...block, content: segment.nodes });
      }
    }
  }
  pmJson.content = newBlocks;
  return pmJson;
}

/** Truncate long (data:) srcs for the report. */
function reportSrc(src) {
  return typeof src === 'string' && src.length > 64 ? `${src.slice(0, 64)}…` : src;
}

/**
 * Reject `data:` image srcs (FR-019, CN-6): never fetched, never stored,
 * never written. The node degrades to its alt text (dropped entirely when the
 * alt is empty). Mutates the PM JSON; returns report entries.
 */
function rejectDataImages(pmJson) {
  const rejected = [];
  if (!pmJson || !Array.isArray(pmJson.content)) return rejected;
  pmJson.content = pmJson.content.flatMap((block) => {
    if (!block || block.type !== 'image') return [block];
    const src = block.attrs && block.attrs.src;
    if (schemeOf(src) !== 'data') return [block];
    rejected.push({ src: reportSrc(src), reason: 'data-url' });
    const alt = (block.attrs && block.attrs.alt) || '';
    if (!alt.trim()) return [];
    return [{ type: 'paragraph', content: [{ type: 'text', text: alt }] }];
  });
  return rejected;
}

/** Whether the parsed document has any real content (FR-005 / CN-11 guard). */
function hasRealContent(pmJson) {
  if (!pmJson || !Array.isArray(pmJson.content)) return false;
  return pmJson.content.some((block) => {
    if (!block) return false;
    if (block.type !== 'paragraph') return true;
    if (!Array.isArray(block.content)) return false;
    return block.content.some(
      (n) => (n.type === 'text' && n.text && n.text.trim() !== '') || n.type === 'hardBreak'
    );
  });
}

module.exports = {
  schemeOf,
  cleanedHref,
  isAllowedLinkHref,
  sanitizeLinkMarks,
  reconstructImages,
  rejectDataImages,
  hasRealContent,
  reportSrc,
};
