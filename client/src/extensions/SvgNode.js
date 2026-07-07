import { createDiagramNode } from './diagramBlock';
import { createSvgSanitizer } from '../../../shared/svg-sanitizer.mjs';

let sanitizerPromise = null;

function loadSanitizer() {
  if (!sanitizerPromise) {
    sanitizerPromise = import('dompurify').then(({ default: DOMPurify }) => {
      // Isolated instance: the default dompurify export is a shared singleton
      // (mermaid uses it internally when the bundler dedupes the package), so
      // registering our hooks there would leak the SVG policy into mermaid's
      // own sanitize calls. See shared/svg-sanitizer.mjs.
      const purify = DOMPurify(window);
      return createSvgSanitizer(purify);
    });
  }
  return sanitizerPromise;
}

// Thin config over the shared diagram core (see diagramBlock.js). Unlike
// Mermaid there is no compile step — the source *is* the SVG — so "render"
// reduces to enforcing the sanitize policy (XSS, external references) and
// returning the cleaned markup. Sanitizing here covers both injection points
// in DiagramNodeView (inline preview and fullscreen).
export const SvgNode = createDiagramNode({
  name: 'svg',
  placeholder:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" width="240" height="120">\n' +
    '  <rect x="8" y="8" width="224" height="104" rx="12" fill="#eef2ff" stroke="#6366f1"/>\n' +
    '  <circle cx="70" cy="60" r="28" fill="#6366f1"/>\n' +
    '  <text x="115" y="66" font-family="sans-serif" font-size="16" fill="#312e81">SVG block</text>\n' +
    '</svg>',
  loadRenderer: loadSanitizer,
  render: (source, sanitizer) => sanitizer.sanitizeSvg(source).svg,
  // Shown when an SVG block is pasted back from Google Docs but its source was
  // too large to survive the round-trip. Valid SVG so it renders as a visible
  // notice rather than a bare image (palette matches the Mermaid equivalent).
  droppedPlaceholder:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 72" width="560" height="72">\n' +
    '  <rect x="1" y="1" width="558" height="70" rx="8" fill="#fef3c7" stroke="#b45309"/>\n' +
    '  <text x="16" y="30" font-family="sans-serif" font-size="14" fill="#92400e">⚠ SVG source not preserved — too large for a Google Docs</text>\n' +
    '  <text x="16" y="52" font-family="sans-serif" font-size="14" fill="#92400e">round-trip; re-create from the original</text>\n' +
    '</svg>',
});

export default SvgNode;
