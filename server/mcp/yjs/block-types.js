/**
 * Block-element taxonomy shared by the Yjs serializers and the sandbox
 * helpers. Centralizing these here means a new block type (e.g. another
 * fenced-content variant) only needs to be added to the right set
 * instead of every per-list/per-function literal across the server.
 */

// Block elements whose children are inline content (text + marks). These
// get a trailing \n in plain-text / text-node serialization, and their
// structured-format content is flattened into a string or simple array
// rather than nested children.
const INLINE_CONTENT_BLOCKS = [
  'paragraph',
  'heading',
  'codeBlock',
  'mermaid',
  'svg',
  'listItem',
];

// Subset whose content is treated as a literal string with no inline
// formatting. Drives `forceString` in toStructuredNode and the fenced
// rendering in toMarkdown.
const CODE_LIKE_BLOCKS = ['codeBlock', 'mermaid', 'svg'];

// List wrappers — children are listItem instances, themselves block-level.
const LIST_CONTAINERS = ['bulletList', 'orderedList'];

// All block-level element names known to the editor schema. Used by the
// sandbox helper to decide where to insert \n between sibling parts.
const BLOCK_ELEMENTS = [
  ...INLINE_CONTENT_BLOCKS,
  ...LIST_CONTAINERS,
  'blockquote',
  'horizontalRule',
  'image',
];

const isInlineContentBlock = (name) => INLINE_CONTENT_BLOCKS.includes(name);
const isCodeLikeBlock = (name) => CODE_LIKE_BLOCKS.includes(name);
const isListContainer = (name) => LIST_CONTAINERS.includes(name);
const isBlockElement = (name) => BLOCK_ELEMENTS.includes(name);

module.exports = {
  INLINE_CONTENT_BLOCKS,
  CODE_LIKE_BLOCKS,
  LIST_CONTAINERS,
  BLOCK_ELEMENTS,
  isInlineContentBlock,
  isCodeLikeBlock,
  isListContainer,
  isBlockElement,
};
