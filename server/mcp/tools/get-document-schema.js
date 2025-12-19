/**
 * get_document_schema MCP Tool
 *
 * Returns the ProseMirror/TipTap schema defining available blocks and marks.
 */

// Persistence provider - set by init function (not actually needed but for consistency)
let persistenceProvider = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
}

/**
 * Tool definition for MCP discovery
 */
const name = 'get_document_schema';

const description = `Get the document schema - shows all available blocks and marks.

═══════════════════════════════════════════════════════════════════════════
WHAT IS THE SCHEMA?
═══════════════════════════════════════════════════════════════════════════

The schema defines what you can put in documents:
- BLOCKS: Document structure elements (paragraphs, headings, lists, etc.)
- MARKS: Inline text formatting (bold, italic, links, etc.)

This tool returns the complete schema so you know what's possible when
creating or updating document content.

═══════════════════════════════════════════════════════════════════════════
WHEN TO USE THIS
═══════════════════════════════════════════════════════════════════════════

Call this when you need to:
- Understand what block types are available
- See what marks (formatting) you can apply
- Learn the attributes for each block type
- Validate content before updating documents

═══════════════════════════════════════════════════════════════════════════
WHAT YOU GET BACK
═══════════════════════════════════════════════════════════════════════════

BLOCK TYPES:
- doc: The root document container
- paragraph: Regular text paragraphs
- heading: Section headings (levels 1-3)
- bulletList: Unordered (bullet) lists
- orderedList: Numbered lists
- listItem: Individual list items
- codeBlock: Code blocks with syntax highlighting

MARK TYPES:
- bold: Bold text
- italic: Italic text
- underline: Underlined text
- strike: Strikethrough text
- link: Hyperlinks with href attribute

ATTRIBUTES:
Each block/mark type includes:
- name: The type name
- type: "block" or "mark"
- attributes: Required or optional attributes
- content: What can be inside (for blocks)
- description: Human-readable explanation

═══════════════════════════════════════════════════════════════════════════
EXAMPLE RETURN VALUE
═══════════════════════════════════════════════════════════════════════════

{
  "blocks": {
    "paragraph": {
      "type": "block",
      "content": "inline*",
      "group": "block",
      "description": "A regular paragraph of text"
    },
    "heading": {
      "type": "block",
      "content": "inline*",
      "group": "block",
      "attributes": {
        "level": {
          "type": "integer",
          "values": [1, 2, 3],
          "default": 1
        }
      },
      "description": "A heading with level 1-3"
    },
    "codeBlock": {
      "type": "block",
      "content": "text*",
      "attributes": {
        "language": {
          "type": "string",
          "optional": true
        }
      },
      "description": "A code block with optional syntax highlighting"
    }
  },
  "marks": {
    "bold": {
      "type": "mark",
      "description": "Bold text formatting"
    },
    "italic": {
      "type": "mark",
      "description": "Italic text formatting"
    },
    "link": {
      "type": "mark",
      "attributes": {
        "href": {
          "type": "string",
          "required": true
        }
      },
      "description": "Hyperlink with href attribute"
    }
  }
}

═══════════════════════════════════════════════════════════════════════════
HOW TO USE THIS INFORMATION
═══════════════════════════════════════════════════════════════════════════

1. Check available blocks before calling update_document_block
2. Verify mark types before adding formatting
3. Understand required attributes for each type
4. Build valid content structures

Example: If you want to create a heading, the schema tells you:
- Type: "heading"
- Required attribute: "level" (1, 2, or 3)
- Content: Can contain inline formatted text

So you'd create:
{
  "type": "heading",
  "level": 2,
  "content": "My Heading"
}

═══════════════════════════════════════════════════════════════════════════
NO PARAMETERS NEEDED
═══════════════════════════════════════════════════════════════════════════

This tool doesn't need any parameters - it always returns the same schema.`;

const inputSchema = {
  type: 'object',
  properties: {},
  required: [],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments (none needed)
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Schema definition
 */
async function handler(args, agentToken) {
  // Define the schema for our ProseMirror/TipTap document
  const schema = {
    blocks: {
      doc: {
        type: 'block',
        content: 'block+',
        description: 'The root document node containing all other blocks',
      },
      paragraph: {
        type: 'block',
        content: 'inline*',
        group: 'block',
        description: 'A regular paragraph of text. Can contain formatted text with marks.',
      },
      heading: {
        type: 'block',
        content: 'inline*',
        group: 'block',
        attributes: {
          level: {
            type: 'integer',
            values: [1, 2, 3],
            default: 1,
            description: 'Heading level: 1 (largest) to 3 (smallest)',
          },
        },
        description: 'A heading with configurable level (1-3). Used for section titles.',
      },
      bulletList: {
        type: 'block',
        content: 'listItem+',
        group: 'block',
        description: 'An unordered (bullet) list containing list items.',
      },
      orderedList: {
        type: 'block',
        content: 'listItem+',
        group: 'block',
        attributes: {
          start: {
            type: 'integer',
            default: 1,
            optional: true,
            description: 'Starting number for the list',
          },
        },
        description: 'An ordered (numbered) list containing list items.',
      },
      listItem: {
        type: 'block',
        content: 'paragraph block*',
        description: 'A single item in a bullet or numbered list. Can contain paragraphs and nested lists.',
      },
      codeBlock: {
        type: 'block',
        content: 'text*',
        group: 'block',
        attributes: {
          language: {
            type: 'string',
            optional: true,
            description: 'Programming language for syntax highlighting (e.g., "javascript", "python")',
          },
        },
        description: 'A code block with optional syntax highlighting.',
      },
    },
    marks: {
      bold: {
        type: 'mark',
        description: 'Bold text formatting. Applied to text within blocks.',
      },
      italic: {
        type: 'mark',
        description: 'Italic text formatting. Applied to text within blocks.',
      },
      underline: {
        type: 'mark',
        description: 'Underlined text formatting. Applied to text within blocks.',
      },
      strike: {
        type: 'mark',
        description: 'Strikethrough text formatting. Applied to text within blocks.',
      },
      link: {
        type: 'mark',
        attributes: {
          href: {
            type: 'string',
            required: true,
            description: 'URL the link points to',
          },
        },
        description: 'Hyperlink with href attribute. Applied to text to make it clickable.',
      },
    },
    notes: {
      contentExpressions: {
        'inline*': 'Zero or more inline elements (text with marks)',
        'text*': 'Plain text only (no marks)',
        'block+': 'One or more block elements',
        'listItem+': 'One or more list items',
        'paragraph block*': 'A paragraph followed by zero or more blocks',
      },
      usage: 'Use blocks to structure documents, marks to format text within blocks.',
    },
  };

  return schema;
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
