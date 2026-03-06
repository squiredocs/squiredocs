/**
 * Node Validation for Structured Content
 *
 * Validates structured node definitions before building Yjs structures.
 */

const VALID_NODE_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'codeBlock',
  'listItem',
];

const VALID_MARKS = ['bold', 'italic', 'underline', 'strike'];

/**
 * Validate a structured node
 * @param {object} node - Node to validate
 * @throws {Error} If invalid
 */
function validateNode(node) {
  if (!node || typeof node !== 'object') {
    throw new Error('Node must be an object');
  }

  const { type, content, children, level, language } = node;

  if (!type || !VALID_NODE_TYPES.includes(type)) {
    throw new Error(
      `Invalid node type: ${type}. Valid types: ${VALID_NODE_TYPES.join(', ')}`
    );
  }

  // Heading validation
  if (type === 'heading') {
    if (![1, 2, 3].includes(level)) {
      throw new Error(`Heading level must be 1, 2, or 3. Got: ${level}`);
    }
  }

  // List validation
  if (['bulletList', 'orderedList'].includes(type)) {
    if (!Array.isArray(children) || children.length === 0) {
      throw new Error(`${type} must have non-empty children array`);
    }
    children.forEach((child, idx) => {
      if (child.type !== 'listItem') {
        throw new Error(`${type} child at index ${idx} must be a listItem`);
      }
      validateNode(child);
    });
  }

  // Content validation
  if (content !== undefined) {
    if (typeof content === 'string') {
      // Plain string is valid
    } else if (Array.isArray(content)) {
      content.forEach((item, idx) => {
        if (typeof item === 'string') {
          // Plain string in array is valid
        } else if (typeof item === 'object') {
          validateTextContent(item, idx);
        } else {
          throw new Error(`Content item at index ${idx} must be string or object`);
        }
      });
    } else {
      throw new Error('content must be string or array');
    }
  }

  // Code block validation
  if (type === 'codeBlock') {
    if (content !== undefined && typeof content !== 'string') {
      throw new Error('codeBlock content must be a string');
    }
    if (language !== undefined && typeof language !== 'string') {
      throw new Error('codeBlock language must be a string');
    }
  }
}

/**
 * Validate formatted text content
 * @param {object} item - Text content item
 * @param {number} index - Index in content array
 * @throws {Error} If invalid
 */
function validateTextContent(item, index) {
  if (item.text === undefined || typeof item.text !== 'string') {
    throw new Error(
      `Content item at index ${index} must have text property (string)`
    );
  }

  if (item.marks !== undefined) {
    if (!Array.isArray(item.marks)) {
      throw new Error(`Content item at index ${index}: marks must be an array`);
    }

    item.marks.forEach((mark, markIdx) => {
      if (typeof mark === 'string') {
        if (!VALID_MARKS.includes(mark)) {
          throw new Error(
            `Invalid mark "${mark}" at content[${index}].marks[${markIdx}]. Valid: ${VALID_MARKS.join(', ')}`
          );
        }
      } else if (typeof mark === 'object') {
        if (mark.type === 'link') {
          if (!mark.href || typeof mark.href !== 'string') {
            throw new Error(
              `Link mark at content[${index}].marks[${markIdx}] must have href (string)`
            );
          }
        } else {
          throw new Error(
            `Unknown mark type "${mark.type}" at content[${index}].marks[${markIdx}]`
          );
        }
      } else {
        throw new Error(
          `Mark at content[${index}].marks[${markIdx}] must be string or object`
        );
      }
    });
  }
}

/**
 * Validate a Yjs XmlFragment against the ProseMirror schema.
 *
 * Converts the fragment to a ProseMirror node and calls node.check(),
 * which throws if the structure violates schema content constraints.
 *
 * @param {Y.XmlFragment} xmlFragment - Document fragment to validate
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateDocumentSchema(xmlFragment) {
  try {
    const { yXmlFragmentToProseMirrorRootNode } = require('y-prosemirror');
    const { schema } = require('../../../shared/prosemirror-schema');
    const node = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema);
    node.check();
    return { valid: true, error: null };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

module.exports = {
  validateNode,
  validateTextContent,
  validateDocumentSchema,
  VALID_NODE_TYPES,
  VALID_MARKS,
};
