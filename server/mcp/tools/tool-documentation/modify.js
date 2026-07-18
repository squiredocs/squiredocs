/**
 * Full scripting API reference for the modify tool.
 *
 * Served on demand via the get_tool_documentation MCP tool and passed in full
 * to the in-app chat agent (chatDescription). The MCP-facing description of
 * modify is a short summary because clients such as Claude Code truncate tool
 * descriptions at 2KB.
 */

const MODIFY_DOCUMENTATION = `Modify the document using a TypeScript script.

═══════════════════════════════════════════════════════════════════════════
INCREMENTAL AUTHORING (READ THIS FIRST)
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
- SECTION BY SECTION (best for new documents): title, then intro, then one
  modify call per section
- STRUCTURE FIRST (best for complex docs): all headings first, then fill in
  each section with its own modify call
- BY CONTENT TYPE (best for formatting tasks): one modify call per
  transformation (fix headings, bold TODOs, convert URLs to links, ...)
- ITEM BY ITEM (best for long lists): create the list with the first few
  items, append the rest in batches

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
QUICK DECISION GUIDE: What kind of edit am I doing?
═══════════════════════════════════════════════════════════════════════════

Before writing your script, ask yourself:

□ Creating NEW content from scratch?
  → Build incrementally across multiple modify calls (section by section)
  → See "INCREMENTAL AUTHORING" strategies above

□ Transforming EXISTING content? (e.g., formatting, converting block types)
  → Iterate through blocks and modify in place
  → DON'T delete everything and recreate — breaks collaboration & undo history
  → See the block-type transformation example in EXAMPLES below

□ Complex nested structure you're unsure about?
  → Use read_document with format:"structured" FIRST to understand the tree
  → See PITFALL 6 below

□ Finding/formatting patterns in text?
  → Use built-in helpers: findByText(), xpath(), findTextNode()
  → Use indexOf() + length for positions — never count manually
  → See QUICK REFERENCE below

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
    { type: 'taskList', items: ListItem[] }   - GFM checklist; items accept { content, checked?: boolean }
      (checked defaults false; nested items under a task item default to taskList)
    { type: 'codeBlock', content: string }
    { type: 'mermaid', content: string }   - Mermaid diagram source, rendered live in the editor
    { type: 'svg', content: string }       - raw SVG markup, rendered live (sanitized) in the editor.
      Scripts, event handlers, foreignObject, and external references are stripped
      at render time — reference only #fragment ids and data:image URIs.
    { type: 'blockquote', content: string | FormattedContent }
    { type: 'horizontalRule' }
    { type: 'table', headers?: string[], rows: string[][] }
      Note: Table rows can contain FormattedContent arrays for rich text (bold, color, etc.)
      Note: For colspan/rowspan, use low-level API (see Example 7c below)

  ListItem = string | FormattedContent | NestedItem
  NestedItem = { content: string | FormattedContent, checked?: boolean, items?: ListItem[], type?: 'bulletList' | 'orderedList' | 'taskList' }
  FormattedContent = Array<string | { text: string, attrs: object }>

  Position options:
    { at: 'start' }  - Insert at beginning
    { at: 'end' }    - Insert at end (default)
    { before: element | xpath }  - Insert before target
    { after: element | xpath }   - Insert after target

  Example - Mixed blocks with formatted content, positioned after a heading:
      appendBlocks(doc, [
        { type: 'heading', level: 2, content: 'Summary' },
        { type: 'paragraph', content: [
          'Text with ',
          { text: 'bold', attrs: { bold: true } },
          ' and ',
          { text: 'italic', attrs: { italic: true } }
        ]},
        { type: 'blockquote', content: 'To be or not to be...' },
        { type: 'horizontalRule' }
      ], { after: '//heading[contains(., "Introduction")]' });

  Example - Nested lists and a table (cells may use FormattedContent):
      appendBlocks(doc, [
        { type: 'bulletList', items: [
          'Simple item',
          { content: 'Item with sub-items', items: ['Sub-item 1', 'Sub-item 2'] },
          { content: 'Mixed nesting', items: ['Numbered child'], type: 'orderedList' }
        ]},
        { type: 'table',
          headers: ['Name', 'Status'],
          rows: [
            ['Alice', [{ text: 'Active', attrs: { bold: true } }]],
            ['Bob', [{ text: 'On Leave', attrs: { textStyle: { color: '#dc2626' } } }]]
          ]
        }
      ]);

cloneBlocks(input)  ⭐ COPY CONTENT BETWEEN DOCUMENTS
  - Deep-copies Yjs nodes into fresh, detached nodes you can insert anywhere
  - Required when copying from a source document (see WORKING WITH SOURCE
    DOCUMENTS below): Yjs nodes cannot be moved between documents, so
    inserting a node from sources[guid] directly throws — clone it instead
  - Preserves everything: text marks, heading levels, nested lists, tables,
    code/mermaid blocks, image attributes
  - input: a source fragment (clones ALL its blocks), a single node, or an
    array of nodes; always returns an array of detached nodes
  - Example:
      doc.insert(doc.length, cloneBlocks(sources[guid]));           // whole doc
      doc.insert(0, cloneBlocks(xpath('//table', sources[guid])));  // just tables

fromMarkdown(md)  ⭐ CONVERT MARKDOWN TO BLOCKS
  - Parses a markdown string into fresh, detached nodes with the SAME contract
    as cloneBlocks output — insert them anywhere with doc.insert / appendBlocks
    positioning; they stream live like any other mutation
  - Covers the full supported grammar: headings, paragraphs, ordered/bullet
    lists (nested), tables, fenced code, mermaid/svg blocks, links, and inline
    marks (bold/italic/code/strike/…)
  - Secure by default: link hrefs are sanitized to an allowlist
    (http/https/mailto/app-relative — javascript:/data:/vbscript:/file: links
    lose their mark, text kept); data: images are dropped; external images are
    fetched and rehosted into this document after the script runs (failures
    degrade to a plain link)
  - Never throws: fromMarkdown('') returns []; input it cannot structure
    becomes literal-text paragraphs (never-lose-content)
  - Synchronous; no network happens inside the script (rehosting is a
    host-side post-pass)
  - Example:
      const nodes = fromMarkdown("## Notes\\n- item **bold**");
      const h = xpathFirst('//heading[@level=1]');
      doc.insert(doc.toArray().indexOf(h) + 1, nodes);  // insert after the H1

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
  - 'taskList', 'taskItem' (GFM checklist; taskItem has a boolean checked attribute)
  - 'codeBlock', 'blockquote', 'horizontalRule'
  - 'mermaid' (diagram block — child Y.XmlText holds the Mermaid source)
  - 'svg' (raw SVG block — child Y.XmlText holds the SVG markup, rendered sanitized:
     scripts, event handlers, foreignObject, and external references are stripped;
     use only #fragment refs and data:image URIs)
  - 'image' (atom block — attrs: src, alt?, title?, width?). src MUST be an existing
     app image URL (/api/docs/:docId/images/:imageId). You can move, reorder, delete,
     and edit alt/title/width of existing images, but you CANNOT create a new image
     here — an external/invented src is stripped. To add a new image the user attached
     in chat, use the insert_image tool instead.
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
    href must use an allowed protocol: http, https, mailto, or an app-relative
    path (/…) or fragment (#…). javascript:, data:, vbscript:, and file: hrefs
    are stripped after your script runs (the link mark is removed, the text is
    kept) and reported in the result's linkErrors.

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
WORKING WITH SOURCE DOCUMENTS
═══════════════════════════════════════════════════════════════════════════

Pass sourceDocGuids (an array of up to 10 other document UUIDs) to expose
those documents READ-ONLY inside your script as the \`sources\` global. Use
this to copy, merge, or concatenate content across documents WITHOUT reading
them into chat and re-typing them — the content moves entirely inside the
sandbox, with full formatting fidelity.

  sources                    - object keyed by docGuid; each value is that
                               document's root fragment (read-only)
  Object.keys(sources)       - guids in the same order as your sourceDocGuids
                               array (use this for concatenation order)

Access rules:
  - Viewer access to each source is enough (the target still requires editor)
  - All sources are checked up front; the call fails before running your
    script if any guid is unknown or not shared with the user
  - Total source size is capped (~8MB of document updates); if exceeded, the
    error lists per-document sizes so you can drop or split sources

Reading sources — all read helpers work on sources:
  getFormattedContent, getTextContent, extractText, findTextNode,
  findElements, findByNodeName, findByText, getPlainText, getParagraphs,
  and xpath()/xpathFirst() with an explicit context:
      const tables = xpath('//table', sources[guid]);

Sources are READ-ONLY:
  - Mutation methods (insert, delete, setAttribute, format, ...) throw
  - xpath() on a source does not highlight (highlights are target-doc only)
  - To modify a source document, make a separate modify call targeting it

Copying content — ALWAYS use cloneBlocks():
  Yjs nodes belong to their document and cannot be inserted into another one.
  cloneBlocks() deep-copies nodes into fresh detached nodes that you insert
  into the target. Formatting, tables, nested lists, and attributes survive.

Example — concatenate several documents into the target:

  modify({
    docGuid: targetGuid,
    sourceDocGuids: [guidA, guidB, guidC],
    script: \`
      export default function edit(doc: Y.XmlFragment) {
        for (const guid of Object.keys(sources)) {   // input order
          doc.insert(doc.length, cloneBlocks(sources[guid]));
          appendBlocks(doc, [{ type: 'horizontalRule' }]);
        }
      }
    \`
  })

Example — pull one section out of another document:

  const src = sources[guid];
  const section = xpath(
    '//heading[contains(., "Roadmap")]/following-sibling::*', src);
  appendBlocks(doc, [{ type: 'heading', level: 2, content: 'Roadmap' }]);
  doc.insert(doc.length, cloneBlocks(section));

Images: cloned image nodes are handled automatically after your script runs —
each image referencing another document is COPIED into the target document
and its src rewritten (reported in the result's imagesCopied). Images from
documents the user cannot access are removed and reported in imageErrors.

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- script: TypeScript source code (required)
- timeout: Execution timeout in milliseconds (optional, default: 5000, max: 30000)
- sourceDocGuids: Up to 10 other document UUIDs exposed read-only to the
  script as the \`sources\` global (optional; see WORKING WITH SOURCE DOCUMENTS)
- echoContent: Echo the full updated document content in the result (optional,
  default: false). Leave it off for normal editing — the returned diff is
  enough to verify your change, and skipping the echo keeps responses small
  across a long editing session.

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- changed: true if the document content actually changed (false = targeting missed, re-read the doc)
- message: Diagnostic guidance when changed is false (explains likely cause and next steps)
- operationCount: Number of Yjs operations performed
- summary: Object mapping operation types to counts
- content: The full updated document (structured format, same as read_document), only when echoContent: true was passed and the document is under 60,000 characters. This reflects the document AFTER your edit.
- contentOmitted: true when the content was not echoed (echoContent off, or the document is too large). Use read_document if you need the full current content.
- blockCount / characterCount: Size of the updated document (present only with echoContent: true)
- clock: The document's update counter as observed BEFORE your edit (the pre-edit baseline), so you can track its version
- editRange: { clockStart, clockEnd } — the durable identifier of exactly this edit's rows in the document's update log (present only when changed is true). This is the handle undo uses; you don't need to pass it anywhere — the undo tool resolves your edits from the log.
- editRangePending: true — returned instead of editRange in the rare case the edit's durability was still being confirmed when the call returned; the server finishes recording in the background
- conflict: true if the edit was refused because someone else changed the document since you last read it. The result then includes editedBy (who changed it). Re-read the document with read_document (or retry with echoContent: true to get the current content inline), fold in their changes, and retry.
- mermaidErrors: Present only if the document contains Mermaid diagram(s) with INVALID syntax. An array of { block, error, source } — these diagrams will show an error to the user instead of rendering. The edit was still applied; fix the reported diagram(s) in a follow-up modify.
- svgErrors: Present only if the document contains SVG block(s) with problems: content the editor's sanitizer will strip (scripts, event handlers, foreignObject, external references), a missing <svg> root, or malformed XML. Same { block, error, source } shape as mermaidErrors. The edit was still applied; fix the reported block(s) in a follow-up modify.
- sourceDocGuids: Echo of the source documents that were exposed to the script
  (present only when sourceDocGuids was passed)
- imagesCopied: Present only if image node(s) referencing another document were
  found after your edit. Each { from, to } records an image copied into this
  document with its src rewritten (e.g. cloned via cloneBlocks from a source doc).
- imageErrors: Present only if your script left image node(s) with a non-app src. Those images were REMOVED (an array of { src }). Only reference existing app image URLs (/api/docs/:docId/images/:imageId); to add a new image from chat use the insert_image tool.
- linkErrors: Present only if your script left link mark(s) with a disallowed href protocol. The link MARK was removed (the text was kept) — an array of { href, reason }. Link hrefs may only use http, https, mailto, or app-relative (/… or #…) schemes; javascript:, data:, vbscript:, and file: are stripped. Fix the reported href(s) with an allowed protocol if the link is intended.
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

// Example 2: Add a summary section at the start (use appendBlocks — see helpers)
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      appendBlocks(doc, [
        { type: 'heading', level: 1, content: 'Summary' },
        { type: 'paragraph', content: 'This document contains important information.' }
      ], { at: 'start' });
    }
  \`
});

// Example 3: Find and replace text across all blocks
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

// Example 4: Convert markdown to blocks with fromMarkdown()
// ⭐ KEY PATTERN: never hand-roll markdown parsing. fromMarkdown(md) returns
// detached, ready-to-insert nodes (SAME contract as cloneBlocks) covering the
// full supported grammar — headings, lists, tables, code/mermaid fences,
// links, and inline formatting — with link hrefs sanitized and images handled
// by the import policy. Place the result with the positioning primitives you
// already know (doc.insert, appendBlocks-style xpath targeting).
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      // Convert markdown, then insert right after a located heading.
      const nodes = fromMarkdown("## Notes\\n\\n- item **bold**\\n- item _italic_");
      const anchor = xpathFirst('//heading[@level=1]');
      const idx = anchor ? doc.toArray().indexOf(anchor) + 1 : doc.length;
      doc.insert(idx, nodes);

      // fromMarkdown('') returns []; unstructurable input degrades to literal
      // paragraphs — it never throws on content it merely cannot structure.
    }
  \`
});

// Example 5: Mixed formatting with createFormattedText() — no position counting
// (For formatting EXISTING text, insert-then-format with indexOf: see PITFALL 5)
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      const para = new Y.XmlElement('paragraph');
      const text = createFormattedText([
        { text: 'Important:', attrs: { bold: true } },
        ' visit ',
        { text: 'Example Site', attrs: { link: { href: 'https://example.com' } } },
        ' for more info'
      ]);
      para.insert(0, [text]);
      doc.insert(doc.length, [para]);
    }
  \`
});

// Example 6: Table with colspan/rowspan/colwidth (requires low-level API;
// for simple tables use appendBlocks — see helpers)
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      // Cell factory: table → tableRow → tableHeader/tableCell → paragraph → text
      function makeCell(tag, content, colspan = 1, colwidth = null) {
        const cell = new Y.XmlElement(tag);
        cell.setAttribute('colspan', colspan);
        cell.setAttribute('rowspan', 1);
        cell.setAttribute('colwidth', colwidth);  // e.g. [150], or [200, 250] when colspan=2
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, content);
        p.insert(0, [t]);
        cell.insert(0, [p]);
        return cell;
      }

      const table = new Y.XmlElement('table');

      const headerRow = new Y.XmlElement('tableRow');
      headerRow.insert(0, [
        makeCell('tableHeader', 'Merged Header', 2),  // spans 2 columns
        makeCell('tableHeader', 'Status')
      ]);
      table.insert(0, [headerRow]);

      const dataRow = new Y.XmlElement('tableRow');
      dataRow.insert(0, [
        makeCell('tableCell', 'Alice', 1, [150]),   // 150px wide
        makeCell('tableCell', 'Engineer', 1, [300]),
        makeCell('tableCell', 'Active')
      ]);
      table.insert(1, [dataRow]);

      doc.insert(doc.length, [table]);
    }
  \`
});

// Example 7: TextStyle marks (color, font) — MUST be nested in a textStyle object
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      const para = new Y.XmlElement('paragraph');
      const text = createFormattedText([
        { text: 'Red text', attrs: { textStyle: { color: '#ff0000' } }},
        ' and ',
        { text: 'custom font', attrs: { textStyle: { fontFamily: 'Georgia', fontSize: '18px' } }},
        ' and ',
        { text: 'bold red', attrs: { bold: true, textStyle: { color: '#dc2626' } }}
      ]);
      para.insert(0, [text]);
      doc.insert(doc.length, [para]);
    }
  \`
});

═══════════════════════════════════════════════════════════════════════════
QUICK REFERENCE: Key behaviors & techniques
═══════════════════════════════════════════════════════════════════════════

⭐ VERIFY YOUR CHANGES: the modify result includes a diff of what your edit
changed — confirm it matches your intent (location, formatting, list nesting).
For a targeted check of the surrounding document, use read_document with an
xpath, e.g.:
  "//heading[contains(., 'Summary')]/following-sibling::*[position()<=3]"
Or pass echoContent: true to get the full updated document back inline.

SCRIPT EXECUTION BEHAVIOR:
• All changes batched in single transaction → entire script = one undo step
• If script fails mid-execution → all changes automatically rolled back
• Scripts run on live document → changes sync to all users in real-time

KEY TECHNIQUES:
• Use extractText()/toDelta() to extract text, NOT toString() → see PITFALL 3
• Use createFormattedText() for mixed formatting → see PITFALL 5
• Use { attribute: null } to remove formatting → see PITFALL 2
• Use indexOf/regex for format() positions — never count manually:
     const term = 'TODO';
     const index = extractText(textNode).indexOf(term);
     if (index >= 0) textNode.format(index, term.length, { bold: true });
     const match = content.match(/https?:\\/\\/\\S+/);
     if (match) textNode.format(match.index, match[0].length, { link: { href: match[0] } });
• Check instance types before operations:
     child instanceof Y.XmlElement / child instanceof Y.XmlText
• For nested structures, use recursive functions to traverse the tree

═══════════════════════════════════════════════════════════════════════════
COMMON PITFALLS
═══════════════════════════════════════════════════════════════════════════

⚠️ PITFALL 1: Reusing Yjs Elements Without Cloning

PROBLEM: A Yjs element (XmlElement, XmlText) can only exist in ONE location in
the document tree. Inserting the same instance twice — or inserting an element
that already has a parent — fails silently or behaves unexpectedly.

❌ WRONG - Reusing the same element instance:
  doc.insert(0, [template]);  // First insert works
  doc.insert(1, [template]);  // ❌ FAILS SILENTLY - element already has a parent!

✅ CORRECT - Clone for each insertion:
  doc.insert(0, [template.clone()]);
  doc.insert(1, [template.clone()]);

To MOVE an element to a new parent: clone it (e.g. firstPara.clone()), delete
the original from its current location, then insert the clone at the new spot.
Cloning is NOT needed to modify elements in place (setAttribute, format, etc.)
or when creating a fresh element for each insertion.

⚠️ PITFALL 2: Using Empty Object {} to Remove Formatting

PROBLEM: An empty object {} in format() does NOT remove formatting - it leaves
the text unchanged. Explicitly set each attribute to null instead.

❌ WRONG - no effect, bold text stays bold:
  text.format(0, content.length, {});

✅ CORRECT - set attributes to null (list every mark you want removed):
  text.format(0, content.length, { bold: null, italic: null, underline: null, strike: null });

⚠️ PITFALL 3: Using toString() Instead of toDelta()

toString() on Y.XmlText returns XML markup when the text has formatting.
Always use extractText(textNode) (or toDelta()) to get plain text.

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

⚠️ PITFALL 5: Sequential Inserts with Different Attributes on Unattached XmlText

PROBLEM: Calling insert() multiple times with DIFFERENT formatting attributes on
a Y.XmlText that is NOT yet attached to the document can produce REVERSED text
(a Yjs CRDT quirk: unattached nodes can't order operations across attribute
boundaries).

❌ WRONG - differently-formatted inserts on an unattached node:
  const text = new Y.XmlText();  // Not attached to doc yet!
  text.insert(0, 'Visit our website at ', {});
  text.insert(text.length, 'Example Site', { link: { href: 'https://example.com' } });
  // Result: "Example SiteVisit our website at " - REVERSED!

⭐ PREFERRED - createFormattedText() (segments in order, impossible to get wrong):
  const text = createFormattedText([
    'Visit our website at ',
    { text: 'Example Site', attrs: { link: { href: 'https://example.com' } } }
  ]);

✅ FALLBACK - insert ALL text plain first, then format ranges found via indexOf:
  const fullText = 'Visit our website at Example Site';
  text.insert(0, fullText);
  const linkText = 'Example Site';
  text.format(fullText.indexOf(linkText), linkText.length, { link: { href: 'https://example.com' } });

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

RECOMMENDATION: Use read_document with format: "structured" BEFORE writing
complex modify scripts — understanding the document tree prevents wasted effort
and runtime errors. Always use XPath for targeting — never positional indexing.
`;

module.exports = { MODIFY_DOCUMENTATION };
