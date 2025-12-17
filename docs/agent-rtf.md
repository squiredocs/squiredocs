# Agent Rich Text Formatting via MCP

## Overview

This document describes the design for enabling AI agents to work exclusively with structured, formatted content when reading and updating documents via the Model Context Protocol (MCP). Agents always interact with the native TipTap document structure, ensuring full formatting fidelity and semantic understanding.

## Current State

### What Works Today

**Reading**: Agents can read documents in structured format:

```javascript
get_document({ docGuid: "uuid", format: "structured" })

// Returns:
{
  docGuid: "uuid",
  content: [
    { type: "heading", level: 1, content: "My Document" },
    { type: "paragraph", content: "Introduction text..." },
    { type: "bulletList", children: [
        { type: "listItem", content: "First item" }
      ]
    }
  ],
  format: "structured",
  role: "owner"
}
```

**Writing**: Limited to plain paragraphs only (see `server/mcp/tools/update-document.js:118-142`):

```javascript
update_document({
  docGuid: "uuid",
  operation: "append",
  content: "This becomes a plain paragraph"  // String only
})
```

### The Problem

**Asymmetry**: Agents can read headings, lists, formatted text, and links, but can only write plain paragraphs. This prevents agents from:

- Creating well-structured documents with headings and sections
- Maintaining document formatting when editing
- Inserting lists, code blocks, or formatted text
- Working with documents semantically (understanding structure)

## Design Philosophy

### Always Structured

Agents work exclusively with structured content. This provides:

1. **Semantic Understanding**: Agents see and manipulate document structure, not just text
2. **Format Preservation**: No information loss from format conversion
3. **Simplicity**: One format to learn, no mode switching
4. **Type Safety**: Clear schema with validation
5. **Future-Proof**: Easy to extend with new node types

### Human vs. Agent Interface

- **Humans**: Use visual TipTap editor with toolbar buttons
- **Agents**: Use structured JSON API with full programmatic control
- **Both**: See the same document state via Yjs CRDT synchronization

## Structured Content Schema

### Node Types

Based on TipTap's extensions (see `client/src/components/Editor.jsx:86-96`):

```typescript
type DocumentContent = StructuredNode[];

type StructuredNode =
  | ParagraphNode
  | HeadingNode
  | BulletListNode
  | OrderedListNode
  | CodeBlockNode;

type ParagraphNode = {
  type: "paragraph";
  content?: TextContent[];
};

type HeadingNode = {
  type: "heading";
  level: 1 | 2 | 3;
  content?: TextContent[];
};

type BulletListNode = {
  type: "bulletList";
  children: ListItemNode[];
};

type OrderedListNode = {
  type: "orderedList";
  children: ListItemNode[];
};

type ListItemNode = {
  type: "listItem";
  content?: TextContent[];
};

type CodeBlockNode = {
  type: "codeBlock";
  language?: string;
  content: string;  // Plain text only (no marks in code blocks)
};

type TextContent = string | FormattedText;

type FormattedText = {
  text: string;
  marks?: Mark[];
};

type Mark = "bold" | "italic" | "underline" | "strike" | LinkMark;

type LinkMark = {
  type: "link";
  href: string;
};
```

### Content Field Rules

- **Empty content**: Omit the `content` field or use `content: []`
- **Plain text**: `content: ["text"]` or `content: "text"` (shorthand for single string)
- **Formatted text**: `content: [{ text: "...", marks: [...] }]`
- **Mixed**: `content: ["plain ", { text: "formatted", marks: ["bold"] }, " text"]`

## Tool Definitions

### 1. get_document (Modified)

Always returns structured format. Remove `format` parameter.

```javascript
// Request
{
  docGuid: "550e8400-e29b-41d4-a716-446655440000"
}

// Response
{
  docGuid: "550e8400-e29b-41d4-a716-446655440000",
  content: [
    { type: "heading", level: 1, content: "Project Overview" },
    { type: "paragraph", content: "This document describes..." }
  ],
  role: "editor",
  updatedAt: "2025-12-16T10:30:00Z"
}
```

**Empty document**:
```javascript
{
  docGuid: "...",
  content: [],  // Empty array for blank document
  role: "owner",
  updatedAt: "2025-12-16T10:30:00Z"
}
```

### 2. update_document (Redesigned)

Replace all operations with structured node operations.

**Input Schema**:
```javascript
{
  type: "object",
  properties: {
    docGuid: {
      type: "string",
      format: "uuid",
      description: "Document UUID"
    },
    operation: {
      type: "string",
      enum: ["replace", "insert", "delete", "append"],
      description: "Operation type"
    },
    nodes: {
      type: "array",
      items: { type: "object" },
      description: "Array of structured nodes to insert/append/replace"
    },
    position: {
      type: "integer",
      minimum: 0,
      description: "Node position (0-indexed) for insert operation"
    },
    count: {
      type: "integer",
      minimum: 1,
      description: "Number of nodes to delete for delete operation"
    }
  },
  required: ["docGuid", "operation"]
}
```

### Operations

#### Replace: Replace entire document

```javascript
{
  docGuid: "uuid",
  operation: "replace",
  nodes: [
    { type: "heading", level: 1, content: "New Document" },
    { type: "paragraph", content: "Fresh start." }
  ]
}

// Returns:
{
  success: true,
  message: "Replaced document with 2 nodes",
  docGuid: "uuid"
}
```

#### Append: Add nodes to end

```javascript
{
  docGuid: "uuid",
  operation: "append",
  nodes: [
    { type: "heading", level: 2, content: "Conclusion" },
    { type: "paragraph", content: "To summarize..." }
  ]
}

// Returns:
{
  success: true,
  message: "Appended 2 nodes to document",
  docGuid: "uuid"
}
```

#### Insert: Insert nodes at specific position

```javascript
{
  docGuid: "uuid",
  operation: "insert",
  position: 3,  // Node index, not character position
  nodes: [
    {
      type: "bulletList",
      children: [
        { type: "listItem", content: "New item" }
      ]
    }
  ]
}

// Returns:
{
  success: true,
  message: "Inserted 1 node at position 3",
  docGuid: "uuid"
}
```

**Position semantics**:
- `position: 0` = before first node
- `position: 1` = between first and second node
- `position: N` = after Nth node (append if N ≥ document length)

#### Delete: Remove nodes

```javascript
{
  docGuid: "uuid",
  operation: "delete",
  position: 2,
  count: 3  // Delete 3 nodes starting at position 2
}

// Returns:
{
  success: true,
  message: "Deleted 3 nodes starting at position 2",
  docGuid: "uuid"
}
```

## Examples

### Example 1: Create a Meeting Notes Document

```javascript
update_document({
  operation: "replace",
  nodes: [
    {
      type: "heading",
      level: 1,
      content: [
        { text: "Meeting Notes - ", marks: ["bold"] },
        { text: "Q4 Planning" }
      ]
    },
    {
      type: "paragraph",
      content: "Date: December 16, 2025"
    },
    {
      type: "heading",
      level: 2,
      content: "Attendees"
    },
    {
      type: "bulletList",
      children: [
        { type: "listItem", content: "Alice (Engineering)" },
        { type: "listItem", content: "Bob (Product)" },
        { type: "listItem", content: "Carol (Design)" }
      ]
    },
    {
      type: "heading",
      level: 2,
      content: "Discussion Topics"
    },
    {
      type: "orderedList",
      children: [
        { type: "listItem", content: "Q4 roadmap review" },
        { type: "listItem", content: "Resource allocation" },
        { type: "listItem", content: "Timeline adjustments" }
      ]
    },
    {
      type: "heading",
      level: 2,
      content: "Action Items"
    },
    {
      type: "bulletList",
      children: [
        {
          type: "listItem",
          content: [
            { text: "Alice", marks: ["bold"] },
            { text: ": Complete feature spec by Friday" }
          ]
        },
        {
          type: "listItem",
          content: [
            { text: "Bob", marks: ["bold"] },
            { text: ": Schedule follow-up meeting" }
          ]
        }
      ]
    }
  ]
})
```

### Example 2: Append Code Documentation

```javascript
update_document({
  operation: "append",
  nodes: [
    {
      type: "heading",
      level: 3,
      content: "Usage Example"
    },
    {
      type: "paragraph",
      content: "Here's how to authenticate with the API:"
    },
    {
      type: "codeBlock",
      language: "javascript",
      content: `const token = await authenticate({
  email: 'user@example.com',
  password: 'secret'
});

const data = await fetchData(token);
console.log(data);`
    },
    {
      type: "paragraph",
      content: [
        { text: "For more details, see the " },
        {
          text: "API documentation",
          marks: [{ type: "link", href: "https://docs.example.com/api" }]
        },
        { text: "." }
      ]
    }
  ]
})
```

### Example 3: Insert a Warning Section

```javascript
// First, read the document to find where to insert
const doc = await get_document({ docGuid });

// Find the position after the introduction heading
const introIndex = doc.content.findIndex(
  node => node.type === "heading" && node.content.includes("Introduction")
);

// Insert warning after introduction
update_document({
  operation: "insert",
  position: introIndex + 1,
  nodes: [
    {
      type: "paragraph",
      content: [
        { text: "⚠️ Warning: ", marks: ["bold"] },
        {
          text: "This feature is experimental and may change.",
          marks: ["italic"]
        }
      ]
    }
  ]
})
```

### Example 4: Build a Document Incrementally

```javascript
// Start with a title
await update_document({
  operation: "replace",
  nodes: [
    { type: "heading", level: 1, content: "Product Specification" }
  ]
});

// Add overview section
await update_document({
  operation: "append",
  nodes: [
    { type: "heading", level: 2, content: "Overview" },
    { type: "paragraph", content: "This product will..." }
  ]
});

// Add features section
await update_document({
  operation: "append",
  nodes: [
    { type: "heading", level: 2, content: "Key Features" },
    {
      type: "bulletList",
      children: [
        { type: "listItem", content: "Real-time collaboration" },
        { type: "listItem", content: "Offline support" },
        { type: "listItem", content: "Version history" }
      ]
    }
  ]
});
```

### Example 5: Structured Editing Workflow

```javascript
// 1. Read current document
const doc = await get_document({ docGuid });

// 2. Analyze structure
const sections = doc.content.filter(node => node.type === "heading");
console.log("Document has", sections.length, "sections");

// 3. Find section to modify
const conclusionIndex = doc.content.findIndex(
  node => node.type === "heading" &&
  node.content?.toString().includes("Conclusion")
);

// 4. Delete old conclusion content
const nextSectionIndex = doc.content.findIndex(
  (node, idx) => idx > conclusionIndex && node.type === "heading"
);
const nodesToDelete = nextSectionIndex === -1
  ? doc.content.length - conclusionIndex - 1
  : nextSectionIndex - conclusionIndex - 1;

if (nodesToDelete > 0) {
  await update_document({
    operation: "delete",
    position: conclusionIndex + 1,
    count: nodesToDelete
  });
}

// 5. Insert new conclusion
await update_document({
  operation: "insert",
  position: conclusionIndex + 1,
  nodes: [
    {
      type: "paragraph",
      content: "In summary, this approach provides three key benefits:"
    },
    {
      type: "orderedList",
      children: [
        { type: "listItem", content: "Improved performance" },
        { type: "listItem", content: "Better user experience" },
        { type: "listItem", content: "Easier maintenance" }
      ]
    }
  ]
});
```

## Implementation Guide

### 1. Update get_document Tool

File: `server/mcp/tools/get-document.js`

**Remove** the `format` parameter and always return structured content:

```javascript
const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    }
    // Remove 'format' parameter
  },
  required: ['docGuid'],
};

async function handler(args, agentToken) {
  // ... permission checks ...

  const ydoc = await loadYDoc(pool, docGuid);
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Always use structured format
  const content = toStructured(xmlFragment);

  return {
    docGuid,
    content,  // Array of structured nodes
    role,
    updatedAt,
  };
}
```

### 2. Redesign update_document Tool

File: `server/mcp/tools/update-document.js`

**Replace** the entire implementation to work with structured nodes:

```javascript
const { buildYjsNode } = require('../yjs/node-builder');
const { validateNode } = require('../yjs/validation');

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'Document UUID',
    },
    operation: {
      type: 'string',
      enum: ['replace', 'insert', 'delete', 'append'],
      description: 'Operation: replace (replace all), insert (at position), delete (remove nodes), append (add to end)',
    },
    nodes: {
      type: 'array',
      items: { type: 'object' },
      description: 'Structured nodes to insert/append/replace',
    },
    position: {
      type: 'integer',
      minimum: 0,
      description: 'Node position (0-indexed) for insert/delete operations',
    },
    count: {
      type: 'integer',
      minimum: 1,
      description: 'Number of nodes to delete (required for delete operation)',
    },
  },
  required: ['docGuid', 'operation'],
};

async function handler(args, agentToken) {
  const { docGuid, operation, nodes, position, count } = args;

  // Validate required parameters for each operation
  if (['replace', 'insert', 'append'].includes(operation)) {
    if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
      throw new Error(`nodes array required for ${operation} operation`);
    }
    // Validate each node
    nodes.forEach(node => validateNode(node));
  }

  if (operation === 'insert' && position === undefined) {
    throw new Error('position required for insert operation');
  }

  if (operation === 'delete') {
    if (position === undefined) {
      throw new Error('position required for delete operation');
    }
    if (count === undefined) {
      throw new Error('count required for delete operation');
    }
  }

  // ... permission checks ...

  let message;

  await documentService.updateDocument(
    docGuid,
    (ydoc) => {
      const xmlFragment = ydoc.get('default', Y.XmlFragment);

      switch (operation) {
        case 'replace': {
          // Clear entire document
          while (xmlFragment.length > 0) {
            xmlFragment.delete(0, 1);
          }

          // Insert new nodes
          const yjsNodes = nodes.map(node => buildYjsNode(node));
          xmlFragment.insert(0, yjsNodes);

          message = `Replaced document with ${nodes.length} nodes`;
          break;
        }

        case 'append': {
          const yjsNodes = nodes.map(node => buildYjsNode(node));
          xmlFragment.insert(xmlFragment.length, yjsNodes);

          message = `Appended ${nodes.length} nodes to document`;
          break;
        }

        case 'insert': {
          const insertPos = Math.min(position, xmlFragment.length);
          const yjsNodes = nodes.map(node => buildYjsNode(node));
          xmlFragment.insert(insertPos, yjsNodes);

          message = `Inserted ${nodes.length} nodes at position ${insertPos}`;
          break;
        }

        case 'delete': {
          const actualCount = Math.min(count, xmlFragment.length - position);
          if (actualCount > 0) {
            xmlFragment.delete(position, actualCount);
            message = `Deleted ${actualCount} nodes starting at position ${position}`;
          } else {
            message = `No nodes deleted (position ${position} out of range)`;
          }
          break;
        }
      }
    },
    userId
  );

  // Update timestamp
  await pool.query('UPDATE documents SET updated_at = now() WHERE id = $1', [docGuid]);

  return { success: true, message, docGuid };
}
```

### 3. Create Node Builder

File: `server/mcp/yjs/node-builder.js`

Build Yjs structures from JSON node definitions:

```javascript
const Y = require('yjs');

/**
 * Convert structured node to Yjs XmlElement
 * @param {object} node - Structured node definition
 * @returns {Y.XmlElement}
 */
function buildYjsNode(node) {
  const { type, content, children, level, language } = node;

  const element = new Y.XmlElement(type);

  // Set attributes
  if (level !== undefined) {
    element.setAttribute('level', level.toString());
  }
  if (language !== undefined) {
    element.setAttribute('language', language);
  }

  // Build content
  if (type === 'codeBlock') {
    // Code blocks: plain text only
    const text = new Y.XmlText();
    text.insert(0, content || '');
    element.insert(0, [text]);
  } else if (children) {
    // Lists: process child nodes
    const childElements = children.map(child => buildYjsNode(child));
    element.insert(0, childElements);
  } else if (content) {
    // Text content: may include marks
    const textElements = buildTextContent(content);
    if (textElements.length > 0) {
      element.insert(0, textElements);
    }
  }

  return element;
}

/**
 * Build text content with marks
 * @param {string|Array} content - Text content
 * @returns {Array<Y.XmlText>}
 */
function buildTextContent(content) {
  // Shorthand: single string
  if (typeof content === 'string') {
    const text = new Y.XmlText();
    text.insert(0, content);
    return [text];
  }

  // Array of strings and formatted text objects
  if (!Array.isArray(content)) {
    return [];
  }

  const result = [];

  for (const item of content) {
    if (typeof item === 'string') {
      const text = new Y.XmlText();
      text.insert(0, item);
      result.push(text);
    } else if (item.text !== undefined) {
      const text = new Y.XmlText();
      text.insert(0, item.text);

      // Apply marks
      if (item.marks && item.marks.length > 0) {
        for (const mark of item.marks) {
          if (typeof mark === 'string') {
            // Simple mark: bold, italic, etc.
            text.format(0, item.text.length, { [mark]: true });
          } else if (mark.type === 'link') {
            // Link mark
            text.format(0, item.text.length, {
              link: { href: mark.href }
            });
          }
        }
      }

      result.push(text);
    }
  }

  return result;
}

module.exports = { buildYjsNode, buildTextContent };
```

**Note**: The above mark application uses ProseMirror's format API. Verify this matches how TipTap's Collaboration extension expects marks in the Yjs structure. You may need to adjust based on TipTap internals.

### 4. Create Validation Module

File: `server/mcp/yjs/validation.js`

Validate node structure before building:

```javascript
const VALID_NODE_TYPES = ['paragraph', 'heading', 'bulletList', 'orderedList', 'codeBlock', 'listItem'];
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
    throw new Error(`Invalid node type: ${type}. Valid types: ${VALID_NODE_TYPES.join(', ')}`);
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
  }
}

/**
 * Validate formatted text content
 */
function validateTextContent(item, index) {
  if (!item.text || typeof item.text !== 'string') {
    throw new Error(`Content item at index ${index} must have text property (string)`);
  }

  if (item.marks !== undefined) {
    if (!Array.isArray(item.marks)) {
      throw new Error(`Content item at index ${index}: marks must be an array`);
    }

    item.marks.forEach((mark, markIdx) => {
      if (typeof mark === 'string') {
        if (!VALID_MARKS.includes(mark)) {
          throw new Error(`Invalid mark "${mark}" at content[${index}].marks[${markIdx}]. Valid: ${VALID_MARKS.join(', ')}`);
        }
      } else if (typeof mark === 'object') {
        if (mark.type === 'link') {
          if (!mark.href || typeof mark.href !== 'string') {
            throw new Error(`Link mark at content[${index}].marks[${markIdx}] must have href (string)`);
          }
        } else {
          throw new Error(`Unknown mark type "${mark.type}" at content[${index}].marks[${markIdx}]`);
        }
      } else {
        throw new Error(`Mark at content[${index}].marks[${markIdx}] must be string or object`);
      }
    });
  }
}

module.exports = { validateNode };
```

### 5. Update Tool Descriptions

File: `server/mcp/tools/index.js`

Update tool descriptions to reflect structured-only approach:

```javascript
const getDocument = require('./get-document');
const updateDocument = require('./update-document');
// ... other tools

// Update descriptions
getDocument.description = 'Read document content as structured nodes (headings, paragraphs, lists, etc.)';

updateDocument.description = `Update document content using structured nodes.

Supports operations:
- replace: Replace entire document with new nodes
- append: Add nodes to end of document
- insert: Insert nodes at specific position
- delete: Remove nodes

Nodes can be: paragraph, heading (level 1-3), bulletList, orderedList, codeBlock
Text can have marks: bold, italic, underline, strike, link`;
```

## Agent Guidelines

When instructing AI agents how to use the MCP tools, provide these guidelines:

### Reading Documents

```
Always use get_document to read the current document structure before making changes.
The response contains an array of structured nodes representing the document.

Example:
const doc = await get_document({ docGuid: "..." });
// doc.content is an array of nodes like:
// [{ type: "heading", level: 1, content: "Title" }, ...]
```

### Creating New Documents

```
Use the replace operation to create a new document from scratch.
Build an array of structured nodes representing the desired document.

Example: Create a simple report
await update_document({
  operation: "replace",
  nodes: [
    { type: "heading", level: 1, content: "Monthly Report" },
    { type: "paragraph", content: "Summary of activities for December 2025." }
  ]
});
```

### Adding to Documents

```
Use the append operation to add content to the end of a document.

Example: Add a conclusion section
await update_document({
  operation: "append",
  nodes: [
    { type: "heading", level: 2, content: "Conclusion" },
    { type: "paragraph", content: "In summary..." }
  ]
});
```

### Inserting Content

```
Use the insert operation to add content at a specific position.
Position is node index (0 = before first node, 1 = after first node, etc.)

Example: Insert a warning after the title
await update_document({
  operation: "insert",
  position: 1,
  nodes: [
    {
      type: "paragraph",
      content: [
        { text: "Warning: ", marks: ["bold"] },
        { text: "Draft version", marks: ["italic"] }
      ]
    }
  ]
});
```

### Removing Content

```
Use the delete operation to remove nodes by position and count.

Example: Delete 2 nodes starting at position 3
await update_document({
  operation: "delete",
  position: 3,
  count: 2
});
```

### Text Formatting

```
To apply formatting to text, use the marks property:
- Bold: marks: ["bold"]
- Italic: marks: ["italic"]
- Underline: marks: ["underline"]
- Strikethrough: marks: ["strike"]
- Link: marks: [{ type: "link", href: "https://..." }]
- Multiple: marks: ["bold", "italic"]

Example: Formatted paragraph
{
  type: "paragraph",
  content: [
    { text: "This is " },
    { text: "bold and italic", marks: ["bold", "italic"] },
    { text: " and this is a " },
    { text: "link", marks: [{ type: "link", href: "https://example.com" }] },
    { text: "." }
  ]
}
```

### Creating Lists

```
Lists have a children array containing listItem nodes.

Example: Bulleted list
{
  type: "bulletList",
  children: [
    { type: "listItem", content: "First item" },
    { type: "listItem", content: "Second item" },
    { type: "listItem", content: [
        { text: "Third item with " },
        { text: "formatting", marks: ["bold"] }
      ]
    }
  ]
}

Example: Numbered list (orderedList works the same way)
{
  type: "orderedList",
  children: [
    { type: "listItem", content: "Step 1" },
    { type: "listItem", content: "Step 2" },
    { type: "listItem", content: "Step 3" }
  ]
}
```

### Code Blocks

```
Code blocks contain plain text (no marks) and optional language.

Example:
{
  type: "codeBlock",
  language: "javascript",
  content: "const x = 42;\nconsole.log(x);"
}
```

## Benefits

### 1. Semantic Document Manipulation

Agents understand document structure and can manipulate it intelligently:

```javascript
// Find all headings
const headings = doc.content.filter(n => n.type === "heading");

// Find the "Risks" section
const risksSection = doc.content.findIndex(
  n => n.type === "heading" && n.content?.includes("Risks")
);

// Add content after that section
await update_document({
  operation: "insert",
  position: risksSection + 1,
  nodes: [...]
});
```

### 2. Format Preservation

When editing documents, agents maintain existing formatting:

```javascript
// Read document
const doc = await get_document({ docGuid });

// Modify a specific paragraph while preserving surrounding structure
const updatedContent = doc.content.map((node, idx) => {
  if (idx === 3) {
    return { ...node, content: "Updated paragraph text" };
  }
  return node;
});

// Replace with updated structure
await update_document({
  operation: "replace",
  nodes: updatedContent
});
```

### 3. Rich Content Generation

Agents can generate properly formatted documents:

```javascript
// Generate a specification document
await update_document({
  operation: "replace",
  nodes: [
    { type: "heading", level: 1, content: "Feature Specification" },
    { type: "heading", level: 2, content: "Overview" },
    { type: "paragraph", content: "..." },
    { type: "heading", level: 2, content: "Requirements" },
    {
      type: "bulletList",
      children: requirements.map(req => ({
        type: "listItem",
        content: req
      }))
    },
    // ... more sections
  ]
});
```

### 4. Consistent Interface

One format for all operations simplifies agent implementation:

- No mode switching between plain-text and structured
- No lossy format conversions
- Easier to test and debug
- Clear contract between agent and service

## Testing Strategy

### Unit Tests

```javascript
// server/mcp/__tests__/yjs/node-builder.test.js
describe('buildYjsNode', () => {
  it('builds paragraph with plain text', () => {
    const node = { type: 'paragraph', content: 'Hello' };
    const yjsNode = buildYjsNode(node);
    expect(yjsNode.nodeName).toBe('paragraph');
  });

  it('builds heading with level', () => {
    const node = { type: 'heading', level: 2, content: 'Title' };
    const yjsNode = buildYjsNode(node);
    expect(yjsNode.getAttribute('level')).toBe('2');
  });

  it('builds formatted text with marks', () => {
    const node = {
      type: 'paragraph',
      content: [{ text: 'bold text', marks: ['bold'] }]
    };
    const yjsNode = buildYjsNode(node);
    // Verify marks were applied
  });
});

// server/mcp/__tests__/yjs/validation.test.js
describe('validateNode', () => {
  it('accepts valid paragraph', () => {
    expect(() => validateNode({
      type: 'paragraph',
      content: 'text'
    })).not.toThrow();
  });

  it('rejects invalid heading level', () => {
    expect(() => validateNode({
      type: 'heading',
      level: 5,
      content: 'text'
    })).toThrow(/level must be 1, 2, or 3/);
  });

  it('rejects empty list', () => {
    expect(() => validateNode({
      type: 'bulletList',
      children: []
    })).toThrow(/non-empty children/);
  });
});
```

### Integration Tests

```javascript
// server/mcp/__tests__/tools/update-document-structured.test.js
describe('update_document with structured nodes', () => {
  it('replaces document with heading and list', async () => {
    await updateDocument({
      docGuid,
      operation: 'replace',
      nodes: [
        { type: 'heading', level: 1, content: 'Title' },
        {
          type: 'bulletList',
          children: [
            { type: 'listItem', content: 'Item 1' },
            { type: 'listItem', content: 'Item 2' }
          ]
        }
      ]
    }, agentToken);

    const doc = await getDocument({ docGuid }, agentToken);
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0].type).toBe('heading');
    expect(doc.content[1].type).toBe('bulletList');
  });

  it('appends nodes to existing document', async () => {
    // Setup: create initial document
    await updateDocument({
      docGuid,
      operation: 'replace',
      nodes: [{ type: 'paragraph', content: 'First' }]
    }, agentToken);

    // Test: append
    await updateDocument({
      docGuid,
      operation: 'append',
      nodes: [{ type: 'paragraph', content: 'Second' }]
    }, agentToken);

    const doc = await getDocument({ docGuid }, agentToken);
    expect(doc.content).toHaveLength(2);
  });

  it('inserts nodes at position', async () => {
    await updateDocument({
      docGuid,
      operation: 'replace',
      nodes: [
        { type: 'paragraph', content: 'First' },
        { type: 'paragraph', content: 'Third' }
      ]
    }, agentToken);

    await updateDocument({
      docGuid,
      operation: 'insert',
      position: 1,
      nodes: [{ type: 'paragraph', content: 'Second' }]
    }, agentToken);

    const doc = await getDocument({ docGuid }, agentToken);
    expect(doc.content[1].content).toBe('Second');
  });

  it('deletes nodes', async () => {
    await updateDocument({
      docGuid,
      operation: 'replace',
      nodes: [
        { type: 'paragraph', content: 'First' },
        { type: 'paragraph', content: 'Second' },
        { type: 'paragraph', content: 'Third' }
      ]
    }, agentToken);

    await updateDocument({
      docGuid,
      operation: 'delete',
      position: 1,
      count: 1
    }, agentToken);

    const doc = await getDocument({ docGuid }, agentToken);
    expect(doc.content).toHaveLength(2);
    expect(doc.content[1].content).toBe('Third');
  });
});
```

## Migration from Current Implementation

### Phase 1: Implement Structured Support

1. Create `server/mcp/yjs/node-builder.js`
2. Create `server/mcp/yjs/validation.js`
3. Update `server/mcp/tools/update-document.js` with new schema and handler
4. Remove `format` parameter from `server/mcp/tools/get-document.js`
5. Add comprehensive tests

### Phase 2: Update Documentation

1. Update `docs/mcp-quickstart.md` with structured examples
2. Add this document to reference docs
3. Update tool descriptions in code
4. Create agent prompt templates with examples

### Phase 3: Deploy and Monitor

1. Deploy to staging environment
2. Test with Claude Desktop/Code using real documents
3. Monitor error rates and validation failures
4. Gather feedback on API ergonomics

## Future Enhancements

### Advanced Text Operations

Support for character-level operations within nodes:

```javascript
{
  operation: "formatText",
  nodePosition: 2,
  startChar: 0,
  endChar: 10,
  marks: ["bold"]
}
```

### Node Transformation

Change node types in place:

```javascript
{
  operation: "transform",
  position: 3,
  newType: "heading",
  level: 2
}
```

### Batch Operations

Apply multiple operations atomically:

```javascript
{
  operation: "batch",
  operations: [
    { operation: "delete", position: 2, count: 1 },
    { operation: "insert", position: 2, nodes: [...] }
  ]
}
```

### Table Support

When TipTap table extension is added:

```javascript
{
  type: "table",
  rows: [
    { cells: [{ content: "Header 1" }, { content: "Header 2" }] },
    { cells: [{ content: "Data 1" }, { content: "Data 2" }] }
  ]
}
```

## Conclusion

By requiring agents to always work with structured content, we create a powerful and consistent interface for programmatic document manipulation. This approach:

- **Eliminates complexity** of format switching and conversion
- **Preserves semantic meaning** of document structure
- **Enables intelligent editing** based on document organization
- **Matches capabilities** of the visual editor
- **Simplifies implementation** with a single code path

The structured format is the natural representation for how documents are stored (Yjs XmlFragment) and displayed (TipTap/ProseMirror), making it the ideal interface for agents.

---

## References

- Implementation: `server/mcp/tools/update-document.js`
- Serialization: `server/mcp/yjs/serialization.js`
- Editor config: `client/src/components/Editor.jsx`
- Example usage: `script/edit-default-doc.js`
- MCP guide: `docs/mcp-quickstart.md`
