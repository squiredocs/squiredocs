/**
 * modify MCP Tool
 *
 * Modify a document using a TypeScript script.
 * Scripts run in a sandboxed environment with access to Yjs API.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { executeScript } = require('../sandbox');
const { toMarkdown } = require('../yjs/serialization');
const { computeChatDiff } = require('../diff-utils');
const { queryAndSerialize } = require('./read-helpers');

// Upper bound on the echoed post-edit content (serialized chars). A modify
// always succeeds in changing the live document; the content echo is a
// convenience so the agent does not have to re-read. If the document is large,
// we omit the echo rather than risk tripping the chat layer's result-size cap
// (which would turn a successful edit into a misleading "too large" error).
const MAX_ECHO_CONTENT_CHARS = 60_000;

// Persistence provider - set by init function
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
const name = 'modify';

const description = `Modify the document using a TypeScript script.

═══════════════════════════════════════════════════════════════════════════
⭐ INCREMENTAL AUTHORING - READ THIS FIRST ⭐
═══════════════════════════════════════════════════════════════════════════

ALWAYS build documents incrementally using MULTIPLE modify calls.
Users watch the document in real-time - they should see content appear
progressively, not all at once.

WHY INCREMENTAL IS BETTER:
✓ Users see progress as you work (engaging experience)
✓ Each change syncs immediately to all connected viewers
✓ Smaller scripts are more reliable and faster
✓ Errors don't lose all work (partial content preserved)
✓ Natural undo boundaries (each modify = one undo step)

RECOMMENDED STRATEGIES (choose based on content):

Strategy 1: SECTION BY SECTION (best for new documents)
  modify: Add document title (h1)
  modify: Add introduction paragraph
  modify: Add "Background" section (h2 + paragraphs)
  modify: Add "Methods" section (h2 + paragraphs)
  modify: Add "Results" section (h2 + bullet list)
  modify: Add "Conclusion" section (h2 + paragraphs)

Strategy 2: STRUCTURE FIRST (best for complex docs)
  modify: Add all headings (h1, h2s, h3s)
  modify: Fill in introduction content
  modify: Fill in section 1 content
  modify: Fill in section 2 content
  modify: Add lists and tables

Strategy 3: BY CONTENT TYPE (best for formatting tasks)
  modify: Update all headings (change levels, fix text)
  modify: Format all TODO items as bold
  modify: Convert all URLs to proper links
  modify: Add bullet list items

Strategy 4: ITEM BY ITEM (best for long lists)
  modify: Create list with first 3 items
  modify: Add next 3 items
  modify: Add final items

ANTI-PATTERNS TO AVOID:
❌ Writing entire document in one massive script
❌ Deleting everything and recreating from scratch
❌ Scripts longer than ~50 lines (break them up!)
❌ Using positional indexing (doc.get(n), element.get(n)) to target elements
  → Positions shift in collaborative docs. Always use XPath instead.

⚠️ WHY "DELETE ALL + RECREATE" IS BAD:
  - Breaks real-time collaboration (other users see flickering)
  - Loses document history and undo/redo state
  - User sees blank doc then sudden content (jarring)
  - Instead: insert new content, or iterate and modify in place

═══════════════════════════════════════════════════════════════════════════
📋 QUICK DECISION: What kind of edit am I doing?
═══════════════════════════════════════════════════════════════════════════

Before writing your script, ask yourself:

□ Creating NEW content from scratch?
  → Build incrementally across multiple modify calls (section by section)
  → See "INCREMENTAL AUTHORING" strategies above

□ Transforming EXISTING content? (e.g., formatting, converting block types)
  → Iterate through blocks and modify in place
  → DON'T delete everything and recreate — breaks collaboration & undo history
  → See Example 5 (block type transformation) below

□ Complex nested structure you're unsure about?
  → Use read_document with format:"structured" FIRST to understand the tree
  → See PITFALL 6 below

□ Finding/formatting patterns in text?
  → Use built-in helpers: findByText(), xpath(), findTextNode()
  → Use indexOf() + length for positions — never count manually
  → See TIP #9 below

═══════════════════════════════════════════════════════════════════════════
SANDBOXED TYPESCRIPT EXECUTION
═══════════════════════════════════════════════════════════════════════════

Executes a TypeScript script with direct access to the Yjs document API.
Scripts can perform complex editing operations using standard Yjs methods.
All changes are atomic (single undo step) and sync in real-time.

WHAT YOU GET:
- Full Yjs API (Y.XmlFragment, Y.XmlElement, Y.XmlText)
- TypeScript type checking and compilation
- Automatic cursor animation for visual feedback
- Atomic undo (entire script = one undo step)
- Real-time sync with all connected users

SECURITY:
- Sandboxed execution (no access to fs, net, require)
- Configurable timeout (default 5s, max 30s)
- Memory limits enforced
- Full rollback on error

SCRIPT STRUCTURE:
Scripts must export a default function that receives the document fragment:

  export default function edit(doc: Y.XmlFragment) {
    // Your editing logic here
  }

═══════════════════════════════════════════════════════════════════════════
BUILT-IN HELPER FUNCTIONS
═══════════════════════════════════════════════════════════════════════════

These helpers are available globally in your scripts - no need to define them!

findTextNode(element)
  - Find first Y.XmlText node in element (recursive)
  - Returns Y.XmlText or null
  - Example: const text = findTextNode(paragraph);

extractText(xmlText)
  - Extract plain text from Y.XmlText using toDelta()
  - CRITICAL: Use this instead of toString() for formatted text
  - Returns string
  - Example: const content = extractText(text);

getTextContent(node)
  - Get all text from element recursively
  - Works with XmlElement or XmlText
  - Returns string
  - Example: const allText = getTextContent(bulletList);

findElements(container, predicate)
  - Find all elements matching a predicate function
  - Returns Y.XmlElement[]
  - Example: findElements(doc, el => el.nodeName === 'heading')

findByNodeName(container, nodeName)
  - Find all elements by node name
  - Returns Y.XmlElement[]
  - Example: const headings = findByNodeName(doc, 'heading');

findByText(container, searchText, caseSensitive=false)
  - Find all elements containing specific text
  - Returns Y.XmlElement[]
  - Example: const todos = findByText(doc, 'TODO');

createFormattedText(segments)  ⭐ PREFERRED FOR MIXED FORMATTING
  - Create Y.XmlText from segments with formatting
  - ✓ No position counting needed — just list segments in order
  - ✓ Avoids text reversal bug on unattached XmlText
  - ✓ Self-documenting: format is visible in segment structure
  - Each segment: string OR { text: string, attrs: object }
  - Returns Y.XmlText
  - Example:
      const text = createFormattedText([
        'Visit ',
        { text: 'Example Site', attrs: { link: { href: 'https://example.com' } } },
        ' for more info'
      ]);
      para.insert(0, [text]);

getFormattedContent(element)  ⭐ READ FORMATTED CONTENT
  - Read formatted content as segments (same format as createFormattedText)
  - Works with paragraph, heading, listItem, tableCell, blockquote
  - Returns array: ["plain", { text: "formatted", attrs: {...} }]
  - Example: const segments = getFormattedContent(paragraph);

setFormattedContent(element, segments)  ⭐ WRITE FORMATTED CONTENT
  - Write segments to element (replaces existing content)
  - Uses same format as createFormattedText
  - Example: setFormattedContent(para, ["Hello ", { text: "world", attrs: { bold: true } }]);

getPlainText(segments)
  - Extract plain text from segments array
  - Useful for searching/matching
  - Example: if (getPlainText(segments).includes('TODO')) { ... }

getParagraphs(container)
  - Read all paragraphs from a container as array of segment arrays
  - For listItem, tableCell, blockquote with multiple paragraphs
  - Example: const paras = getParagraphs(listItem);

setParagraphs(container, segmentArrays)
  - Replace all paragraphs in a container
  - Example: setParagraphs(listItem, [["First para"], ["Second para"]]);

appendBlocks(container, blocks, position?)  ⭐ PREFERRED FOR ADDING CONTENT
  - Create multiple block elements from declarative definitions
  - ✓ Eliminates ~75% of boilerplate for common operations
  - ✓ Supports headings, paragraphs, lists, code blocks
  - ✓ Supports nested lists with arbitrary depth
  - ✓ Supports formatted content within blocks
  - ✓ Supports xpath-based positioning
  - Returns Y.XmlElement[] (the created blocks)

  Block types:
    { type: 'paragraph', content: string | FormattedContent }
    { type: 'heading', level: 1-6, content: string | FormattedContent }
    { type: 'bulletList', items: ListItem[] }
    { type: 'orderedList', items: ListItem[] }
    { type: 'codeBlock', content: string }
    { type: 'blockquote', content: string | FormattedContent }
    { type: 'horizontalRule' }
    { type: 'table', headers?: string[], rows: string[][] }
      Note: Table rows can contain FormattedContent arrays for rich text (bold, color, etc.)
      Note: For colspan/rowspan, use low-level API (see Example 7c below)

  ListItem = string | FormattedContent | NestedItem
  NestedItem = { content: string | FormattedContent, items?: ListItem[], type?: 'bulletList' | 'orderedList' }
  FormattedContent = Array<string | { text: string, attrs: object }>

  Position options:
    { at: 'start' }  - Insert at beginning
    { at: 'end' }    - Insert at end (default)
    { before: element | xpath }  - Insert before target
    { after: element | xpath }   - Insert after target

  Example - Simple content:
      appendBlocks(doc, [
        { type: 'heading', level: 2, content: 'Summary' },
        { type: 'paragraph', content: 'This is the introduction.' },
        { type: 'bulletList', items: ['Point one', 'Point two', 'Point three'] }
      ]);

  Example - Formatted content:
      appendBlocks(doc, [
        { type: 'paragraph', content: [
          'Text with ',
          { text: 'bold', attrs: { bold: true } },
          ' and ',
          { text: 'italic', attrs: { italic: true } }
        ]}
      ]);

  Example - Position after specific heading:
      appendBlocks(doc, [
        { type: 'paragraph', content: 'New content after intro.' }
      ], { after: '//heading[contains(., "Introduction")]' });

  Example - Nested lists:
      appendBlocks(doc, [
        { type: 'bulletList', items: [
          'Simple item',
          { content: 'Item with sub-items', items: ['Sub-item 1', 'Sub-item 2'] },
          { content: 'Mixed nesting', items: ['Numbered child'], type: 'orderedList' }
        ]}
      ]);

  Example - Table (simple):
      appendBlocks(doc, [
        { type: 'table',
          headers: ['Name', 'Role', 'Status'],
          rows: [
            ['Alice', 'Engineer', 'Active'],
            ['Bob', 'Designer', 'On Leave']
          ]
        }
      ]);

  Example - Table (no headers):
      appendBlocks(doc, [
        { type: 'table',
          rows: [
            ['Cell 1', 'Cell 2'],
            ['Cell 3', 'Cell 4']
          ]
        }
      ]);

  Example - Blockquote and horizontal rule:
      appendBlocks(doc, [
        { type: 'blockquote', content: 'To be or not to be...' },
        { type: 'horizontalRule' },
        { type: 'paragraph', content: 'Text after the divider.' }
      ]);

  Example - Table with formatted content (bold, italic, color):
      appendBlocks(doc, [
        { type: 'table',
          headers: ['Date', 'City', 'Event'],
          rows: [
            [
              [{ text: '11', attrs: { bold: true } }, '\\n✈️ Travel Day'],
              [{ text: 'Dublin', attrs: { italic: true } }],
              'Conference'
            ],
            [
              '12',
              [{ text: 'Dublin', attrs: { textStyle: { color: '#dc2626' } } }],
              'Workshop'
            ]
          ]
        }
      ]);

───────────────────────────────────────────────────────────────────────────
XPATH QUERY FUNCTIONS (Recommended for element selection!)
───────────────────────────────────────────────────────────────────────────

xpath(expression, contextNode?)
  - Execute XPath query, return all matching nodes
  - Uses standard XPath syntax - no fragile index-based access!
  - If contextNode omitted, queries from document root
  - Returns Y.XmlElement[] (actual Yjs nodes you can modify)
  - Examples:
      // Find all headings
      const headings = xpath('//heading');

      // Find level-2 headings
      const h2s = xpath('//heading[@level=2]');

      // Find elements containing text
      const todos = xpath('//paragraph[contains(., "TODO")]');

      // Find list after a specific heading
      const list = xpath('//heading[contains(., "June 13")]/following-sibling::bulletList[1]');

      // Query from a specific element
      const items = xpath('.//listItem', bulletList);

xpathFirst(expression, contextNode?)
  - Execute XPath query, return first matching node (or null)
  - Same syntax as xpath(), just returns single result
  - Returns Y.XmlElement | null
  - Example:
      const firstHeading = xpathFirst('//heading');
      if (firstHeading) {
        firstHeading.setAttribute('level', 1);
      }

Supported XPath features:
  ✓ //element           - Descendant selection (searches ALL descendants, including nested structures)
  ✓ [@attr=value]       - Attribute predicates
  ✓ [contains(., text)] - Text content predicates
  ✓ child::*            - Child axis
  ✓ following-sibling:: - Following sibling axis
  ✓ preceding-sibling:: - Preceding sibling axis
  ✗ parent::            - Not supported (Yjs limitation)
  ✗ ancestor::          - Not supported (Yjs limitation)

XPath and nested structures (tables, lists):
  - //paragraph finds ALL paragraphs, including those inside table cells
  - To exclude nested paragraphs: /paragraph or //paragraph[not(ancestor::table)]
  - //paragraph[last()] returns the last paragraph in document order (may be inside a table!)
  - For top-level only: (//paragraph[not(ancestor::table)])[last()]

═══════════════════════════════════════════════════════════════════════════
YJS API AVAILABLE IN SCRIPTS
═══════════════════════════════════════════════════════════════════════════

Y.XmlFragment (document root):
  - toArray() => (XmlElement | XmlText)[]
  - insert(index, content[])
  - delete(index, length)
  - get(index) => XmlElement | XmlText
  - length: number

Y.XmlElement (blocks: paragraph, heading, list, etc.):
  - nodeName: string (e.g., 'paragraph', 'heading')
  - getAttribute(name) => any
  - setAttribute(name, value)
  - toArray() => (XmlElement | XmlText)[]
  - insert(index, content[])
  - delete(index, length)
  - get(index) => XmlElement | XmlText
  - length: number

Y.XmlText (text content with formatting):
  - toString() => string (WARNING: returns XML if formatted)
  - toDelta() => Delta[] (RECOMMENDED for text extraction)
  - insert(offset, text, attributes?)
  - delete(offset, length)
  - format(offset, length, attributes)
  - length: number

TipTap Block Types:
  - 'paragraph', 'heading' (with level: 1-6)
  - 'bulletList', 'orderedList', 'listItem'
  - 'codeBlock', 'blockquote', 'horizontalRule'
  - 'mermaid' (diagram block — child Y.XmlText holds the Mermaid source)
  - 'table', 'tableRow', 'tableCell', 'tableHeader'

Table Structure:
  table
  └── tableRow
      ├── tableHeader (for header cells, typically first row)
      │   └── paragraph → text
      └── tableCell (for data cells)
          └── paragraph → text

  ⚠️ Table cell text is nested inside a paragraph. To read or write cell text,
  use the helpers that handle this automatically:
    getFormattedContent(tableCell)  — reads cell text (navigates cell → paragraph → text)
    setFormattedContent(tableCell, segments) — writes cell text
    findTextNode(tableCell) — returns the inner Y.XmlText node
  Low-level access requires: tableCell.get(0) → paragraph, paragraph.get(0) → text

Table Cell Attributes:
  - colspan: number (merge cells horizontally)
  - rowspan: number (merge cells vertically)
  - colwidth: number[] (column widths in pixels)
    Note: colwidth must be an array: [200] for single column, [100, 150, 200] for multi-column cells
    Example: cell.setAttribute('colwidth', [150]);

Text Marks (formatting):
  - bold, italic, underline, strike, code
  - subscript, superscript
  - link: { href: string }

TextStyle Marks - IMPORTANT nested format required:
  These marks MUST be wrapped in a textStyle object:
  ✓ Correct: { textStyle: { color: '#ff0000' } }
  ✓ Correct: { textStyle: { color: '#ff0000', fontSize: '18px' } }
  ✗ Wrong:   { color: '#ff0000' }  // Must be nested inside textStyle!

  Available properties (include only what you need):
  - color: string
      Supported formats: hex (#ff0000), rgb (rgb(255,0,0)), rgba (rgba(255,0,0,0.5)),
                         named colors (red, blue), hsl (hsl(0,100%,50%))
  - backgroundColor: string (same formats as color)
  - fontFamily: string (e.g., 'Arial', 'Times New Roman', 'Georgia')
  - fontSize: string (e.g., '16px', '1.2em', '20pt')
  - lineHeight: string (e.g., '1.5', '2', '1.8')

  Combining with other marks:
  { bold: true, textStyle: { color: '#ff0000' } }

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- script: TypeScript source code (required)
- timeout: Execution timeout in milliseconds (optional, default: 5000, max: 30000)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- changed: true if the document content actually changed (false = targeting missed, re-read the doc)
- message: Diagnostic guidance when changed is false (explains likely cause and next steps)
- operationCount: Number of Yjs operations performed
- summary: Object mapping operation types to counts
- content: The full updated document (structured format, same as read_document) when changed is true. This reflects the document AFTER your edit, so you do not need to re-read it before the next modify.
- blockCount / characterCount: Size of the updated document
- clock: The document's update counter, so you can track its version
- conflict: true if the edit was refused because someone else changed the document since you last read it. The result then includes editedBy (who changed it) and the current content. Read it, fold in their changes, and retry.
- error: Error message if execution failed

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Example 1: Format all TODO items as bold
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      // Use built-in helper to find all blocks containing "TODO"
      const todos = findByText(doc, 'TODO');

      todos.forEach(block => {
        const text = findTextNode(block);
        if (text) {
          const content = extractText(text);
          const searchTerm = 'TODO';
          const todoIndex = content.indexOf(searchTerm);
          if (todoIndex >= 0) {
            text.format(todoIndex, searchTerm.length, { bold: true });
          }
        }
      });
    }
  \`
});

// Example 1b: Same as above, manual iteration (shows helper usage)
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      // No need to define findTextNode and extractText - they're built-in!
      const blocks = doc.toArray();
      blocks.forEach(block => {
        if (block instanceof Y.XmlElement) {
          const text = findTextNode(block);
          if (text) {
            const content = extractText(text);
            const todoIndex = content.indexOf('TODO');
            if (todoIndex >= 0) {
              text.format(todoIndex, 4, { bold: true });
            }
          }
        }
      });
    }
  \`
});

// Example 2: Add a summary section at the start
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      // Create heading
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', 1);
      const headingText = new Y.XmlText();
      headingText.insert(0, 'Summary');
      heading.insert(0, [headingText]);

      // Create paragraph
      const para = new Y.XmlElement('paragraph');
      const paraText = new Y.XmlText();
      paraText.insert(0, 'This document contains important information.');
      para.insert(0, [paraText]);

      // Insert at start
      doc.insert(0, [heading, para]);
    }
  \`
});

// Example 3: Create a nested bullet list
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      // Create outer list
      const list = new Y.XmlElement('bulletList');

      // First item
      const item1 = new Y.XmlElement('listItem');
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.insert(0, 'Main point');
      p1.insert(0, [t1]);
      item1.insert(0, [p1]);

      // Nested list under first item
      const nestedList = new Y.XmlElement('bulletList');
      const nestedItem = new Y.XmlElement('listItem');
      const np = new Y.XmlElement('paragraph');
      const nt = new Y.XmlText();
      nt.insert(0, 'Sub point');
      np.insert(0, [nt]);
      nestedItem.insert(0, [np]);
      nestedList.insert(0, [nestedItem]);

      // Add nested list to first item
      item1.insert(1, [nestedList]);

      list.insert(0, [item1]);
      doc.insert(doc.length, [list]);
    }
  \`
});

// Example 4: Find and replace text across all blocks
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      const searchText = 'old term';
      const replaceText = 'new term';

      function processElement(element) {
        for (const child of element.toArray()) {
          if (child instanceof Y.XmlText) {
            const delta = child.toDelta();
            const text = delta.map(op => typeof op.insert === 'string' ? op.insert : '').join('');
            let index = 0;
            while ((index = text.indexOf(searchText, index)) !== -1) {
              child.delete(index, searchText.length);
              child.insert(index, replaceText);
              index += replaceText.length;
            }
          } else if (child instanceof Y.XmlElement) {
            processElement(child);
          }
        }
      }

      processElement(doc);
    }
  \`
});

// Example 5: Transform block types in place (e.g., markdown → proper blocks)
// ⭐ KEY PATTERN: Convert existing blocks without deleting the whole document
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      const blocks = doc.toArray();

      // Iterate BACKWARD when replacing blocks (avoids index shifting)
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (!(block instanceof Y.XmlElement) || block.nodeName !== 'paragraph') continue;

        const textNode = findTextNode(block);
        if (!textNode) continue;
        const content = extractText(textNode);

        // Detect markdown heading pattern: # Title, ## Subtitle, ### Section
        const headingMatch = content.match(/^(#{1,3})\\s+(.+)$/);
        if (headingMatch) {
          const level = headingMatch[1].length;
          const text = headingMatch[2];

          // Create new heading block with same content
          const heading = new Y.XmlElement('heading');
          heading.setAttribute('level', level);
          const newText = new Y.XmlText();
          newText.insert(0, text);
          heading.insert(0, [newText]);

          // Replace in place: delete old, insert new at same position
          doc.delete(i, 1);
          doc.insert(i, [heading]);
        }

        // Detect markdown bullet: - Item or * Item
        const bulletMatch = content.match(/^[-*]\\s+(.+)$/);
        if (bulletMatch) {
          const text = bulletMatch[1];

          // Create bullet list with single item
          const list = new Y.XmlElement('bulletList');
          const item = new Y.XmlElement('listItem');
          const para = new Y.XmlElement('paragraph');
          const newText = new Y.XmlText();
          newText.insert(0, text);
          para.insert(0, [newText]);
          item.insert(0, [para]);
          list.insert(0, [item]);

          doc.delete(i, 1);
          doc.insert(i, [list]);
        }
      }
    }
  \`
});

// Example 6: Create mixed formatting (bold + normal text)
// ⭐ PREFERRED: Use createFormattedText() — no position counting needed!
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      // PREFERRED: Use createFormattedText() for mixed formatting
      // Just list segments in order - no manual position counting!

      // Example 1: Bold intro
      const para = new Y.XmlElement('paragraph');
      const text = createFormattedText([
        { text: 'Important:', attrs: { bold: true } },
        ' This is a normal message'
      ]);
      para.insert(0, [text]);
      doc.insert(doc.length, [para]);

      // Example 2: Multiple formats
      const para2 = new Y.XmlElement('paragraph');
      const text2 = createFormattedText([
        'Some ',
        { text: 'bold', attrs: { bold: true } },
        ' text and some ',
        { text: 'italic', attrs: { italic: true } },
        ' text'
      ]);
      para2.insert(0, [text2]);
      doc.insert(doc.length, [para2]);

      // Example 3: Link in text
      const para3 = new Y.XmlElement('paragraph');
      const text3 = createFormattedText([
        'Visit ',
        { text: 'Example Site', attrs: { link: { href: 'https://example.com' } } },
        ' for more info'
      ]);
      para3.insert(0, [text3]);
      doc.insert(doc.length, [para3]);
    }
  \`
});

// Example 6b: FALLBACK — insert-then-format pattern
// Only use this when formatting EXISTING text or when segments aren't known upfront.
// For new text with mixed formatting, always prefer createFormattedText() above.
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      // FALLBACK: Insert-then-format for when you can't use createFormattedText()
      // Use indexOf() to find positions — never count characters manually!
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();

      const fullText = 'Important: This is a normal message';
      text.insert(0, fullText);

      // Use indexOf + length to find format range — no manual counting!
      const boldPart = 'Important:';
      const boldIndex = fullText.indexOf(boldPart);
      text.format(boldIndex, boldPart.length, { bold: true });

      para.insert(0, [text]);
      doc.insert(doc.length, [para]);
    }
  \`
});

// Example 7: Create a table using low-level API
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      // Create table structure: table → tableRow → tableHeader/tableCell → paragraph → text
      const table = new Y.XmlElement('table');

      // Header row
      const headerRow = new Y.XmlElement('tableRow');
      ['Name', 'Email', 'Role'].forEach(headerText => {
        const th = new Y.XmlElement('tableHeader');
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, headerText);
        p.insert(0, [t]);
        th.insert(0, [p]);
        headerRow.insert(headerRow.length, [th]);
      });
      table.insert(0, [headerRow]);

      // Data rows
      const data = [
        ['Alice', 'alice@example.com', 'Engineer'],
        ['Bob', 'bob@example.com', 'Designer']
      ];
      data.forEach(rowData => {
        const row = new Y.XmlElement('tableRow');
        rowData.forEach(cellText => {
          const td = new Y.XmlElement('tableCell');
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, cellText);
          p.insert(0, [t]);
          td.insert(0, [p]);
          row.insert(row.length, [td]);
        });
        table.insert(table.length, [row]);
      });

      doc.insert(doc.length, [table]);
    }
  \`
});

// Example 7b: Create a table using appendBlocks helper (much simpler!)
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      appendBlocks(doc, [
        { type: 'table',
          headers: ['Name', 'Email', 'Role'],
          rows: [
            ['Alice', 'alice@example.com', 'Engineer'],
            ['Bob', 'bob@example.com', 'Designer']
          ]
        }
      ]);
    }
  \`
});

// Example 7c: Table with colspan/rowspan (requires low-level API)
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      const table = new Y.XmlElement('table');

      // Header row with merged cell (colspan)
      const headerRow = new Y.XmlElement('tableRow');

      const th1 = new Y.XmlElement('tableHeader');
      th1.setAttribute('colspan', 2);  // Merge 2 columns
      th1.setAttribute('rowspan', 1);
      th1.setAttribute('colwidth', null);
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.insert(0, 'Merged Header');
      p1.insert(0, [t1]);
      th1.insert(0, [p1]);

      const th2 = new Y.XmlElement('tableHeader');
      th2.setAttribute('colspan', 1);
      th2.setAttribute('rowspan', 1);
      th2.setAttribute('colwidth', null);
      const p2 = new Y.XmlElement('paragraph');
      const t2 = new Y.XmlText();
      t2.insert(0, 'Status');
      p2.insert(0, [t2]);
      th2.insert(0, [p2]);

      headerRow.insert(0, [th1, th2]);
      table.insert(0, [headerRow]);

      // Data row
      const dataRow = new Y.XmlElement('tableRow');
      ['Alice', 'Engineer', 'Active'].forEach(cellText => {
        const td = new Y.XmlElement('tableCell');
        td.setAttribute('colspan', 1);
        td.setAttribute('rowspan', 1);
        td.setAttribute('colwidth', null);
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, cellText);
        p.insert(0, [t]);
        td.insert(0, [p]);
        dataRow.insert(dataRow.length, [td]);
      });
      table.insert(1, [dataRow]);

      doc.insert(doc.length, [table]);
    }
  \`
});

// Example 7d: Table with custom column widths using colwidth attribute
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      const table = new Y.XmlElement('table');
      const row = new Y.XmlElement('tableRow');

      // First cell: 150px width
      const td1 = new Y.XmlElement('tableCell');
      td1.setAttribute('colspan', 1);
      td1.setAttribute('rowspan', 1);
      td1.setAttribute('colwidth', [150]);  // Array with single width
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.insert(0, 'Narrow');
      p1.insert(0, [t1]);
      td1.insert(0, [p1]);

      // Second cell: 300px width
      const td2 = new Y.XmlElement('tableCell');
      td2.setAttribute('colspan', 1);
      td2.setAttribute('rowspan', 1);
      td2.setAttribute('colwidth', [300]);  // Array with single width
      const p2 = new Y.XmlElement('paragraph');
      const t2 = new Y.XmlText();
      t2.insert(0, 'Wide');
      p2.insert(0, [t2]);
      td2.insert(0, [p2]);

      // Third cell: spans 2 columns with different widths
      const td3 = new Y.XmlElement('tableCell');
      td3.setAttribute('colspan', 2);
      td3.setAttribute('rowspan', 1);
      td3.setAttribute('colwidth', [200, 250]);  // Array for each spanned column
      const p3 = new Y.XmlElement('paragraph');
      const t3 = new Y.XmlText();
      t3.insert(0, 'Multi-column');
      p3.insert(0, [t3]);
      td3.insert(0, [p3]);

      row.insert(0, [td1, td2, td3]);
      table.insert(0, [row]);
      doc.insert(doc.length, [table]);
    }
  \`
});

// Example 8: Apply TextStyle marks (color, font, etc.)
// IMPORTANT: TextStyle marks must be wrapped in a textStyle object
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      const para = new Y.XmlElement('paragraph');
      const text = createFormattedText([
        { text: 'Red text', attrs: { textStyle: { color: '#ff0000' } }},
        ' and ',
        { text: 'blue background with white text', attrs: {
          textStyle: { color: '#ffffff', backgroundColor: '#0000ff' }
        }},
        ' and ',
        { text: 'custom font', attrs: { textStyle: { fontFamily: 'Georgia', fontSize: '18px' } }}
      ]);
      para.insert(0, [text]);
      doc.insert(doc.length, [para]);
    }
  \`
});

// Example 8b: Combining TextStyle with other marks (bold + color)
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      const para = new Y.XmlElement('paragraph');
      const text = createFormattedText([
        { text: 'Bold red text', attrs: {
          bold: true,
          textStyle: { color: '#dc2626' }
        }}
      ]);
      para.insert(0, [text]);
      doc.insert(doc.length, [para]);
    }
  \`
});

// Example 9: Create blockquote and horizontal rule
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      // Using appendBlocks helper
      appendBlocks(doc, [
        { type: 'heading', level: 2, content: 'Famous Quote' },
        { type: 'blockquote', content: 'The only way to do great work is to love what you do.' },
        { type: 'horizontalRule' },
        { type: 'paragraph', content: '— Steve Jobs' }
      ]);
    }
  \`
});

// Example 10: Using subscript and superscript
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      // Chemical formula: H₂O
      const para = new Y.XmlElement('paragraph');
      const text = createFormattedText([
        'Water: H',
        { text: '2', attrs: { subscript: true } },
        'O'
      ]);
      para.insert(0, [text]);
      doc.insert(doc.length, [para]);

      // Mathematical: x²
      const para2 = new Y.XmlElement('paragraph');
      const text2 = createFormattedText([
        'Area = x',
        { text: '2', attrs: { superscript: true } }
      ]);
      para2.insert(0, [text2]);
      doc.insert(doc.length, [para2]);
    }
  \`
});

═══════════════════════════════════════════════════════════════════════════
QUICK REFERENCE: Key behaviors & techniques
═══════════════════════════════════════════════════════════════════════════

⭐ VERIFY YOUR CHANGES: After editing, use read_document to confirm the
result matches your intent. This catches errors early and ensures quality.

  // After a modify call, verify the result:
  await read_document({ docGuid: "abc-123", format: "text" });

  // Or check specific sections with xpath:
  await read_document({
    docGuid: "abc-123",
    xpath: "//heading[contains(., 'Summary')]/following-sibling::*[position()<=3]"
  });

WHY VERIFY:
• Confirms content was inserted in the right location
• Catches formatting issues (wrong level, missing attributes)
• Validates list structure and nesting
• Ensures no unintended side effects from complex scripts

SCRIPT EXECUTION BEHAVIOR:
• All changes batched in single transaction → entire script = one undo step
• If script fails mid-execution → all changes automatically rolled back
• Scripts run on live document → changes sync to all users in real-time

KEY TECHNIQUES:
• Use toDelta() to extract text, NOT toString() → see PITFALL 3
• Use createFormattedText() for mixed formatting → see PITFALL 5
• Use { attribute: null } to remove formatting → see PITFALL 2
• Use indexOf/regex for positions — never count manually:

   ✅ Using indexOf + length:
     const content = extractText(textNode);
     const searchTerm = 'TODO';
     const index = content.indexOf(searchTerm);
     if (index >= 0) {
       textNode.format(index, searchTerm.length, { bold: true });
     }

   ✅ Using regex for complex patterns:
     const match = content.match(/https?:\/\/\S+/);
     if (match) {
       textNode.format(match.index, match[0].length, { link: { href: match[0] } });
     }

• Check instance types before operations:
     if (child instanceof Y.XmlElement) { ... }
     if (child instanceof Y.XmlText) { ... }

• For nested structures, use recursive functions to traverse the tree

═══════════════════════════════════════════════════════════════════════════
COMMON PITFALLS
═══════════════════════════════════════════════════════════════════════════

⚠️ PITFALL 1: Reusing Yjs Elements Without Cloning

PROBLEM: Yjs elements (XmlElement, XmlText) can only exist in ONE location in the
document tree at a time. If you try to insert the same object instance in multiple
places or move it between parents, the operation will silently fail or behave
unexpectedly.

WHEN CLONING IS REQUIRED:
- Moving an element from one parent to another
- Reusing the same element structure in multiple locations
- Creating template elements to insert multiple times

WHEN CLONING IS NOT REQUIRED:
- Modifying elements in place (setAttribute, format, etc.)
- Creating new unique elements for each insertion
- Deleting elements from their current location and inserting new ones

❌ WRONG - Reusing the same element instance:
  export default function edit(doc) {
    // Create a template paragraph
    const template = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Template text');
    template.insert(0, [text]);

    // Try to insert the same instance multiple times
    doc.insert(0, [template]);  // First insert works
    doc.insert(1, [template]);  // ❌ FAILS SILENTLY - element already has a parent!
  }

✅ CORRECT - Clone the element for reuse:
  export default function edit(doc) {
    // Create a template paragraph
    const template = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Template text');
    template.insert(0, [text]);

    // Clone for each insertion
    doc.insert(0, [template.clone()]);
    doc.insert(1, [template.clone()]);
    doc.insert(2, [template.clone()]);
  }

❌ WRONG - Moving element between parents without proper handling:
  export default function edit(doc) {
    const firstPara = xpathFirst('//paragraph');
    if (!firstPara) return;

    // Try to move it to a list (this won't work as expected)
    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    item.insert(0, [firstPara]);  // ❌ Element still belongs to doc!

    doc.insert(1, [list]);
  }

✅ CORRECT - Delete from old location, create new structure:
  export default function edit(doc) {
    const firstPara = xpathFirst('//paragraph');
    if (!firstPara) return;

    // Clone the element to preserve its content
    const clonedPara = firstPara.clone();

    // Delete from original location
    const idx = doc.toArray().indexOf(firstPara);
    if (idx >= 0) doc.delete(idx, 1);

    // Create new structure with cloned content
    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    item.insert(0, [clonedPara]);
    list.insert(0, [item]);

    doc.insert(idx >= 0 ? idx : 0, [list]);
  }

✅ ALSO CORRECT - Extract content and rebuild:
  export default function edit(doc) {
    const firstPara = xpathFirst('//paragraph');
    if (!firstPara) return;

    // Extract text content
    const textContent = getTextContent(firstPara);

    // Delete original
    const idx = doc.toArray().indexOf(firstPara);
    if (idx >= 0) doc.delete(idx, 1);

    // Create new structure with same content
    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    const newPara = new Y.XmlElement('paragraph');
    const newText = new Y.XmlText();
    newText.insert(0, textContent);
    newPara.insert(0, [newText]);
    item.insert(0, [newPara]);
    list.insert(0, [item]);

    doc.insert(idx >= 0 ? idx : 0, [list]);
  }

⚠️ PITFALL 2: Using Empty Object {} to Remove Formatting

PROBLEM: An empty object {} in format() does NOT remove formatting - it leaves
the text unchanged. To remove formatting, you must explicitly set each attribute
to null.

❌ WRONG - empty object has no effect:
  export default function edit(doc) {
    const para = xpathFirst('//paragraph');
    const text = findTextNode(para);
    const content = extractText(text);
    // This does NOTHING - bold text stays bold
    text.format(0, content.length, {});
  }

✅ CORRECT - set attribute to null:
  export default function edit(doc) {
    const para = xpathFirst('//paragraph');
    const text = findTextNode(para);
    const content = extractText(text);
    // This removes bold formatting
    text.format(0, content.length, { bold: null });
  }

✅ CORRECT - remove multiple attributes:
  export default function edit(doc) {
    const para = xpathFirst('//paragraph');
    const text = findTextNode(para);
    const content = extractText(text);
    // Remove all common formatting
    text.format(0, content.length, {
      bold: null,
      italic: null,
      underline: null,
      strike: null
    });
  }

⚠️ PITFALL 3: Using toString() Instead of toDelta()

See TIP #1 above for details on why toDelta() is essential for extracting text
from Y.XmlText nodes that may contain formatting.

⚠️ PITFALL 4: Deleting While Iterating

❌ WRONG - Deleting elements while iterating forward:
  export default function edit(doc) {
    const blocks = doc.toArray();
    for (let i = 0; i < blocks.length; i++) {
      if (shouldDelete(blocks[i])) {
        doc.delete(i, 1);  // ❌ Shifts subsequent indices, causes skipping!
      }
    }
  }

✅ CORRECT - Iterate backward when deleting:
  export default function edit(doc) {
    const blocks = doc.toArray();
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (shouldDelete(blocks[i])) {
        doc.delete(i, 1);  // ✅ Safe - doesn't affect previous indices
      }
    }
  }

✅ ALSO CORRECT - Collect indices first, then delete:
  export default function edit(doc) {
    const blocks = doc.toArray();
    const toDelete = [];

    // First pass: identify what to delete
    for (let i = 0; i < blocks.length; i++) {
      if (shouldDelete(blocks[i])) {
        toDelete.push(i);
      }
    }

    // Second pass: delete from end to start
    for (let i = toDelete.length - 1; i >= 0; i--) {
      doc.delete(toDelete[i], 1);
    }
  }

⚠️ PITFALL 5: Sequential Inserts with Different Attributes on Unattached XmlText

PROBLEM: When you call insert() multiple times with DIFFERENT formatting attributes
on a Y.XmlText that is NOT YET attached to the document, the text segments may
appear in REVERSED order. This is a Yjs behavior where unattached nodes don't
properly track insertion positions across attribute boundaries.

WHEN THIS HAPPENS:
- Creating a new Y.XmlText()
- Calling insert() multiple times with different attributes (e.g., {} then {link:...})
- THEN adding the XmlText to the document

THE TEXT WILL BE REVERSED!

❌ WRONG - Sequential inserts with different attributes on unattached XmlText:
  export default function edit(doc) {
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();  // Not attached to doc yet!

    // These inserts happen while text is unattached
    text.insert(0, 'Visit our website at ', {});
    text.insert(text.length, 'Example Site', { link: { href: 'https://example.com' } });

    para.insert(0, [text]);
    doc.insert(doc.length, [para]);
    // Result: "Example SiteVisit our website at " - REVERSED!
  }

⭐ PREFERRED - Use createFormattedText() helper (no position counting needed!):
  export default function edit(doc) {
    const para = new Y.XmlElement('paragraph');
    // Just list segments in order - impossible to get wrong!
    const text = createFormattedText([
      'Visit our website at ',
      { text: 'Example Site', attrs: { link: { href: 'https://example.com' } } }
    ]);

    para.insert(0, [text]);
    doc.insert(doc.length, [para]);
    // Result: "Visit our website at Example Site" - CORRECT!
    // Self-documenting, no offset calculations, no reversal bug
  }

✅ FALLBACK - Insert all text first, then format (when you can't use createFormattedText):
  export default function edit(doc) {
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();

    // Insert all text as plain text first
    const fullText = 'Visit our website at Example Site';
    text.insert(0, fullText);

    // Use indexOf + length to find format range — no manual counting!
    const linkText = 'Example Site';
    const linkIndex = fullText.indexOf(linkText);
    text.format(linkIndex, linkText.length, { link: { href: 'https://example.com' } });

    para.insert(0, [text]);
    doc.insert(doc.length, [para]);
  }

✅ WORKAROUND - Attach to document first (obscure, prefer createFormattedText):
  export default function edit(doc) {
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();

    // Attach to document FIRST, then sequential inserts work
    para.insert(0, [text]);
    doc.insert(doc.length, [para]);
    text.insert(0, 'Visit our website at ', {});
    text.insert(text.length, 'Example Site', { link: { href: 'https://example.com' } });
  }

WHY THIS HAPPENS:
Yjs uses a CRDT (Conflict-free Replicated Data Type) algorithm that assigns unique
IDs to each operation. When an XmlText is not attached to a document, it doesn't
have proper context for ordering operations with different attributes.

RECOMMENDATION: Use createFormattedText() for mixed formatting — it's the simplest
and most reliable approach. No position counting, no reversal bugs, self-documenting.

⚠️ PITFALL 6: Using Positional Indexing or Modifying Without Understanding Structure

PROBLEM: Using doc.get(n) or element.get(n) to target elements is fragile.
Positions shift when content is added, removed, or reordered — especially in
collaborative documents where multiple users edit simultaneously.

NEVER use positional indexing to target elements. Always use XPath.

❌ WRONG - Positional indexing:
  export default function edit(doc) {
    const list = doc.get(0);          // ❌ fragile — what if content was reordered?
    const item = list.get(0);         // ❌ fragile
    const bulletList = item.get(1);   // ❌ fragile — might not exist!
    bulletList.insert(0, [newItem]);
  }

✅ CORRECT - Use XPath to find elements reliably:
  export default function edit(doc) {
    const list = xpathFirst('//orderedList');
    if (!list) return;  // graceful no-op if not found

    const item = xpathFirst('//orderedList/listItem[1]');
    if (!item) return;

    const bulletList = xpathFirst('.//bulletList', item);
    if (!bulletList) return;

    bulletList.insert(0, [newItem]);
  }

✅ ALSO CORRECT - Use read_document first for complex structures:
  // Step 1: Read document structure BEFORE writing your modify script
  await read_document({
    docGuid: "abc-123",
    format: "structured"
  });

  // Step 2: Study the returned structure to understand the tree
  // Step 3: Write your modify script using XPath to target elements

RECOMMENDATION: Always use read_document with format: "structured" before writing
complex modify scripts. Understanding the document tree prevents wasted effort
and runtime errors. Always use XPath for targeting — never positional indexing.
`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'Document UUID',
    },
    script: {
      type: 'string',
      description: 'TypeScript source code to execute',
    },
    timeout: {
      type: 'integer',
      minimum: 100,
      maximum: 30000,
      default: 5000,
      description: 'Execution timeout in milliseconds',
    },
  },
  required: ['docGuid', 'script'],
};

/**
 * Validates script for common errors before execution
 * @param {string} script - TypeScript script to validate
 * @throws {Error} - If validation fails
 */
function validateScript(script) {
  const errors = [];

  // Check for empty script
  if (!script || script.trim().length === 0) {
    errors.push('Script cannot be empty');
  }

  // Check for export default
  if (!script.includes('export default')) {
    errors.push(
      'Script must include "export default function edit(doc) { ... }".\n' +
      '  Hint: Scripts must export a default function that receives the document as a parameter.'
    );
  }

  // Warn about dangerous patterns (but don't block)
  const warnings = [];

  if (script.includes('while (true)') || script.includes('while(true)')) {
    warnings.push('Detected "while(true)" - this will cause a timeout unless there\'s a break condition');
  }

  if (script.includes('require(')) {
    warnings.push('Detected "require()" - Node.js modules are not available in the sandbox');
  }

  if (script.includes('import ') && script.includes('from ')) {
    warnings.push('Detected "import from" - external modules are not available in the sandbox');
  }

  if (script.includes('process.') || script.includes('__dirname') || script.includes('__filename')) {
    warnings.push('Detected Node.js globals - these are not available in the sandbox');
  }

  if (errors.length > 0) {
    throw new Error(
      `Script validation failed:\n` +
      errors.map(e => `  - ${e}`).join('\n')
    );
  }

  return warnings;
}

/**
 * Tool handler
 * @param {object} args - Tool arguments
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>}
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) {
    throw new Error('Tool not initialized');
  }

  const { docGuid, script, timeout = 5000 } = args;

  // Validate script before execution
  validateScript(script);

  // Validate timeout
  const validatedTimeout = Math.max(100, Math.min(30000, timeout));

  // Get or create session (establishes WebSocket presence)
  // Use 5 minute timeout to ensure cursor persists across multiple modify calls
  const session = await agentPresence.getOrCreateSession(
    docGuid,
    agentToken,
    300, // 5 minute session duration
    { requiredRole: 'editor' }
  );

  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Concurrent-edit guard. The chat layer injects _baseClock (the highest clock
  // the agent has observed for this doc); when another author has edited since
  // then, refuse and return the current content so the agent reconciles.
  // External callers omit _baseClock, so the guard is a no-op for them.
  const baseClock = typeof args._baseClock === 'number' ? args._baseClock : null;
  let recentUpdates = [];
  try {
    recentUpdates = await persistenceProvider.getRecentUpdatesWithUsers(docGuid, 100);
  } catch (e) {
    console.warn('[modify] could not load recent updates for staleness check:', e.message);
  }
  const currentClock = recentUpdates.length
    ? recentUpdates[recentUpdates.length - 1].clock
    : null;

  if (baseClock !== null) {
    const foreign = recentUpdates.filter(u =>
      typeof u.clock === 'number'
      && u.clock > baseClock
      && !(u.agentName === agentToken.agentName && u.userId === agentToken.userId)
    );
    if (foreign.length > 0) {
      // `yjs_updates` rows include non-content writes — `meta` map (title sync),
      // schema normalization by prosemirror on first render, IndexedDB replays
      // on reconnect — all attributed to whichever WebSocket connection applied
      // them. Only refuse the edit if the user-visible content (the `'default'`
      // XmlFragment) actually differs from what the agent expects: i.e. the doc
      // at baseClock replayed with the agent's own subsequent updates. Anything
      // else in the gap is a foreign edit; if those did not change the content
      // tree, the agent's modify is safe.
      let contentDiverged = true;
      try {
        const expectedDoc = await persistenceProvider.getYDocAtClock(docGuid, baseClock);
        // Postgres `clock` is int4 → max 2147483647; safe upper bound for "all rows after baseClock".
        const updatesSince = await persistenceProvider.getUpdatesInRange(
          docGuid, baseClock + 1, 2147483647
        );
        for (const u of updatesSince) {
          const isSelf = u.agentName === agentToken.agentName && u.userId === agentToken.userId;
          if (isSelf && u.updateData) {
            Y.applyUpdate(expectedDoc, u.updateData);
          }
        }
        const expectedMd = toMarkdown(expectedDoc.get('default', Y.XmlFragment));
        const currentMd = toMarkdown(xmlFragment);
        contentDiverged = expectedMd !== currentMd;
      } catch (e) {
        console.warn('[modify] could not gate conflict on content equality; treating as conflict:', e.message);
      }

      if (contentDiverged) {
        const editedBy = [...new Set(
          foreign.map(u => u.userName || u.agentName || 'another collaborator')
        )];
        const conflict = {
          changed: false,
          conflict: true,
          editedBy,
          clock: currentClock,
          message: `This document was edited by ${editedBy.join(', ')} since you last read it. `
            + 'Your change was NOT applied, to avoid overwriting their edits. The current document '
            + 'content is included below. Read it, fold in their changes, then retry your modify.',
        };
        try {
          const serialized = queryAndSerialize(xmlFragment, undefined, 'structured');
          if (JSON.stringify(serialized.content).length <= MAX_ECHO_CONTENT_CHARS) {
            conflict.content = serialized.content;
            conflict.blockCount = serialized.blockCount;
            conflict.characterCount = serialized.characterCount;
          } else {
            conflict.contentOmitted = true;
          }
        } catch (e) {
          console.error('[modify] conflict content serialization failed:', e.message);
        }
        return conflict;
      }
    }
  }

  // Capture state before script execution for change detection and diff
  const blockCountBefore = xmlFragment.toArray().length;
  const mdBefore = toMarkdown(xmlFragment);
  console.log(`[modify:DIAGNOSTIC] docGuid=${docGuid}`);
  console.log(`[modify:DIAGNOSTIC] sessionId=${session.sessionId}`);
  console.log(`[modify:DIAGNOSTIC] blockCountBefore=${blockCountBefore}`);

  try {
    // Execute the script
    const result = await executeScript(script, session, xmlFragment, {
      timeout: validatedTimeout,
    });

    // Capture state after script execution for change detection and diff
    const blockCountAfter = xmlFragment.toArray().length;
    const mdAfter = toMarkdown(xmlFragment);
    const changed = mdBefore !== mdAfter;
    console.log(`[modify:DIAGNOSTIC] blockCountAfter=${blockCountAfter}`);
    console.log(`[modify:DIAGNOSTIC] blocksAdded=${blockCountAfter - blockCountBefore}`);
    console.log(`[modify:DIAGNOSTIC] changed=${changed}`);

    if (result.success) {
      // Compute text diff for chat UI (best-effort)
      let diff = null;
      // Echo the updated document so the agent's view stays current without a
      // re-read. Only when the content actually changed; the chat layer's
      // dedup keeps just the most recent full-doc snapshot in context.
      let content = null;
      let characterCount;
      let updatedBlockCount = blockCountAfter;
      if (changed) {
        try {
          diff = computeChatDiff(mdBefore, mdAfter);
        } catch (e) {
          console.error('[modify] diff computation failed:', e.message);
        }
        try {
          const serialized = queryAndSerialize(xmlFragment, undefined, 'structured');
          content = serialized.content;
          characterCount = serialized.characterCount;
          updatedBlockCount = serialized.blockCount;
        } catch (e) {
          console.error('[modify] content serialization failed:', e.message);
        }
      }

      const response = {
        changed,
        operationCount: result.operationCount,
        summary: result.summary,
        diff,
        clock: currentClock,
      };
      if (changed && content !== null) {
        response.blockCount = updatedBlockCount;
        response.characterCount = characterCount;
        if (JSON.stringify(content).length <= MAX_ECHO_CONTENT_CHARS) {
          response.content = content;
        } else {
          response.contentOmitted = true;
          response.message = `Document updated (${characterCount} characters). `
            + 'The updated content was not echoed because the document is large. '
            + 'Use read_document with an xpath to view specific sections if you need the current content.';
        }
      }
      if (!changed) {
        response.message = 'No changes were made \u2014 your script ran but didn\'t modify the document. '
          + 'This usually means your XPath or element targeting didn\'t match. '
          + 'Re-read the document with format: "structured" to verify the structure before retrying.';
      }
      return response;
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    throw new Error(`Script execution failed: ${error.message}`);
  }
}

module.exports = {
  name,
  description,
  inputSchema,
  handler,
  init,
};
