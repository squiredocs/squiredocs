// Shared utilities between MermaidNode (the TipTap extension) and
// MermaidNodeView (the React component that renders a single block).

// Dataset keys the node view stamps onto the `.mermaid-preview` element so
// the clipboard handler can read them at copy-time. Centralized here so a
// rename can't silently break the two sides.
export const PREVIEW_DATASET = {
  pngUrl: 'pngUrl',
  svgWidth: 'svgWidth',
  svgHeight: 'svgHeight',
  rasterError: 'rasterError',
};

// Normalize a cloned <svg> so it can render correctly as a standalone
// document (canvas drawImage, clipboard SVG fallback, …). Mermaid emits
// `width="100%"` + viewBox + an inherited max-width style, none of which
// survive cleanly outside the editor; firefox additionally refuses to
// decode an SVG <img> without the namespace.
export function prepareSvgForExport(svgClone) {
  svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svgClone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  svgClone.removeAttribute('style');

  const viewBox = svgClone.viewBox && svgClone.viewBox.baseVal;
  const width =
    (viewBox && viewBox.width) ||
    parseFloat(svgClone.getAttribute('width')) ||
    800;
  const height =
    (viewBox && viewBox.height) ||
    parseFloat(svgClone.getAttribute('height')) ||
    600;
  svgClone.setAttribute('width', String(width));
  svgClone.setAttribute('height', String(height));

  return { width, height };
}

// Join a list of class names, dropping falsy entries. Lets callers write
// `cx('foo', cond && 'is-bar')` instead of template-literal soup.
export function cx(...classes) {
  return classes.filter(Boolean).join(' ');
}
