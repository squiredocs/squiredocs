/**
 * HTML Serialization for Yjs Documents
 *
 * Converts between Yjs XmlFragment and HTML using the shared ProseMirror schema.
 * Used for Google Docs sync: export Squire docs as HTML for Google Docs upload,
 * and import Google Docs HTML into Yjs documents.
 *
 * The conversion path:
 *   Export: Yjs XmlFragment → ProseMirror Node → DOM → HTML string
 *   Import: HTML string → DOM → ProseMirror Node → Yjs XmlFragment
 */
const { JSDOM } = require('jsdom');
const { DOMSerializer, DOMParser: PmDOMParser } = require('prosemirror-model');
const {
  yXmlFragmentToProseMirrorRootNode,
  prosemirrorToYXmlFragment,
} = require('y-prosemirror');
// Note: schema imported below from shared module for patching

// Reuse a single JSDOM instance for serialization (stateless)
const jsdom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const jsdomDocument = jsdom.window.document;

// Build a patched schema that serializes textStyle marks as CSS strings
// instead of JS objects. The base schema's textStyle.toDOM returns
// { style: { color: 'red' } } which works in TipTap's renderer but not
// with ProseMirror's DOMSerializer (it calls dom.style.cssText = value,
// which needs a CSS string, not an object).
const { Schema } = require('prosemirror-model');
const { nodes, marks: baseMarks } = require('../../../shared/prosemirror-schema');

const camelToKebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

const patchedMarks = { ...baseMarks };
if (patchedMarks.textStyle) {
  const original = patchedMarks.textStyle;
  patchedMarks.textStyle = {
    ...original,
    toDOM(node) {
      const { color, backgroundColor, fontSize, fontFamily, lineHeight } = node.attrs;
      const parts = [];
      if (color) parts.push(`color: ${color}`);
      if (backgroundColor) parts.push(`background-color: ${backgroundColor}`);
      if (fontSize) parts.push(`font-size: ${fontSize}`);
      if (fontFamily) parts.push(`font-family: ${fontFamily}`);
      if (lineHeight) parts.push(`line-height: ${lineHeight}`);
      return ['span', { style: parts.length ? parts.join('; ') : null }, 0];
    },
  };
}

const htmlSchema = new Schema({ nodes, marks: patchedMarks });

// Create serializer and parser from the patched schema
const serializer = DOMSerializer.fromSchema(htmlSchema);
const parser = PmDOMParser.fromSchema(htmlSchema);

/**
 * Serialize a Yjs XmlFragment to an HTML string.
 *
 * @param {import('yjs').XmlFragment} xmlFragment - Yjs document fragment
 * @returns {string} HTML string
 */
function toHTML(xmlFragment) {
  // Convert Yjs → ProseMirror Node (using the patched schema for correct CSS output)
  const pmNode = yXmlFragmentToProseMirrorRootNode(xmlFragment, htmlSchema);

  // Serialize ProseMirror → DOM fragment
  const domFragment = serializer.serializeFragment(pmNode.content, {
    document: jsdomDocument,
  });

  // Extract HTML string
  const container = jsdomDocument.createElement('div');
  container.appendChild(domFragment);
  const html = container.innerHTML;

  // Clean up: remove the container's children so the shared document stays clean
  container.textContent = '';

  return html;
}

/**
 * Parse an HTML string into a Yjs XmlFragment.
 *
 * ProseMirror's DOMParser handles messy real-world HTML gracefully:
 * - Skips unrecognized elements (<style>, unknown <span>s)
 * - Handles style-based formatting (font-weight:700 → bold mark)
 * - Ignores unknown attributes and classes
 *
 * @param {string} htmlString - HTML content
 * @param {import('yjs').XmlFragment} xmlFragment - Target Yjs fragment to populate
 * @returns {import('yjs').XmlFragment} The populated XmlFragment
 */
function fromHTML(htmlString, xmlFragment) {
  // Parse HTML into a DOM
  const dom = new JSDOM(htmlString);
  const body = dom.window.document.body;

  // Parse DOM → ProseMirror Node
  const pmNode = parser.parse(body);

  // Convert ProseMirror Node → Yjs XmlFragment
  prosemirrorToYXmlFragment(pmNode, xmlFragment);

  return xmlFragment;
}

module.exports = { toHTML, fromHTML };
