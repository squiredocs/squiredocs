// Shared utilities for diagram-as-code blocks (Mermaid, Graphviz, …). The
// format-specific bits live in each block's config (see diagramBlock.js); the
// rasterization, SVG-export normalization, and clipboard source-encoding here
// are format-agnostic — they operate on the rendered SVG and the node name.

// Dataset keys the node view stamps onto the preview element so the clipboard
// handler can read them at copy-time. Centralized here so a rename can't
// silently break the two sides.
export const PREVIEW_DATASET = {
  pngUrl: 'pngUrl',
  svgWidth: 'svgWidth',
  svgHeight: 'svgHeight',
  rasterError: 'rasterError',
};

// Class name on the rendered-preview element. Shared by the node view (which
// writes the dataset onto it) and the clipboard plugin (which reads it off the
// live DOM); keeping it a single constant prevents the two from drifting.
export const PREVIEW_CLASS = 'diagram-preview';

// Prefix used on the <img alt> attribute to encode the diagram source so it can
// survive a paste round-trip through targets (Google Docs etc.) that sanitize
// unknown attributes. Keyed per node name so each diagram type round-trips to
// its own block, and so existing Mermaid clipboard data ([mermaid-src]) stays
// byte-identical.
export const altSourcePrefix = (name) => `[${name}-src]`;

export function encodeSourceForAlt(name, source) {
  return `${altSourcePrefix(name)}${encodeURIComponent(source || '')}`;
}

export function decodeSourceFromAlt(name, altText) {
  const prefix = altSourcePrefix(name);
  if (!altText || !altText.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(altText.slice(prefix.length));
  } catch {
    return null;
  }
}

// Normalize a cloned <svg> so it can render correctly as a standalone document
// (canvas drawImage, clipboard SVG fallback, …). Mermaid emits `width="100%"` +
// viewBox + an inherited max-width style; Graphviz emits `width="62pt"` + a
// viewBox. Neither survives cleanly outside the editor, and Firefox refuses to
// decode an SVG <img> without the namespace. parseFloat strips the `pt` unit.
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

// Rasterize a live <svg> element to a PNG data URL by drawing it onto a canvas
// at `scale`× with a white background. Returns { pngUrl, width, height }.
// Throws (SecurityError) if the SVG taints the canvas — callers fall back to
// inline SVG. Mermaid (with htmlLabels:false) and Graphviz emit plain <text>,
// which does not taint.
export async function rasterizeSvg(svgEl, { scale = 2 } = {}) {
  const clone = svgEl.cloneNode(true);
  const { width, height } = prepareSvgForExport(clone);

  const xml = new XMLSerializer().serializeToString(clone);
  // Base64 data URL (more portable than blob: URLs — some browsers refuse to
  // draw blob:-sourced SVGs onto a canvas).
  const dataUrl =
    'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));

  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return { pngUrl: canvas.toDataURL('image/png'), width, height };
}

// Join a list of class names, dropping falsy entries. Lets callers write
// `cx('foo', cond && 'is-bar')` instead of template-literal soup.
export function cx(...classes) {
  return classes.filter(Boolean).join(' ');
}
