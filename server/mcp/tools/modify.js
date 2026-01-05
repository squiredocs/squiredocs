/**
 * modify MCP Tool
 *
 * Modify a document using a TypeScript script.
 * Scripts run in a sandboxed environment with access to Yjs API.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { executeScript } = require('../sandbox');

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
BEST PRACTICES FOR EACH SCRIPT
═══════════════════════════════════════════════════════════════════════════

Each modify call should do ONE logical thing:
✅ Good: Add a single section (heading + 2-3 paragraphs)
✅ Good: Add a bullet list with 3-5 items
✅ Good: Format all instances of a pattern (TODOs, links, etc.)
✅ Good: Update all headings of a certain level

❌ DON'T: Rewrite entire documents from scratch
  - Deleting all blocks and recreating is inefficient
  - Breaks real-time collaboration (other users see flickering)
  - Loses document history and undo/redo state
  - User sees blank doc then sudden content (jarring)

✅ DO: Make targeted modifications
  - Insert new content at specific positions
  - Find and modify existing blocks in place
  - Use format() to change styling without rewriting
  - Keep scripts focused and under ~50 lines

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
  - 'paragraph', 'heading' (with level: 1-3)
  - 'bulletList', 'orderedList', 'listItem'
  - 'codeBlock'

Text Marks (formatting):
  - bold, italic, underline, strike, code
  - link (with href attribute)

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- script: TypeScript source code (required)
- timeout: Execution timeout in milliseconds (optional, default: 5000, max: 30000)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: true if script executed successfully
- operationCount: Number of Yjs operations performed
- summary: Object mapping operation types to counts
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
          const todoIndex = content.indexOf('TODO');
          if (todoIndex >= 0) {
            text.format(todoIndex, 4, { bold: true });
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

// Example 5: Create mixed formatting (bold + normal text)
await modify({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();

      // Method 1: Insert with explicit formatting (recommended for sequential inserts)
      text.insert(0, 'Important: ', { bold: true });
      text.insert(11, 'This is a normal message', {});  // Empty {} prevents inheriting bold!

      para.insert(0, [text]);
      doc.insert(doc.length, [para]);

      // Method 2: Insert plain text first, then format (recommended for complex formatting)
      const para2 = new Y.XmlElement('paragraph');
      const text2 = new Y.XmlText();
      text2.insert(0, 'Some bold text and some italic text');
      text2.format(5, 4, { bold: true });    // Format 'bold' as bold
      text2.format(23, 6, { italic: true }); // Format 'italic' as italic

      para2.insert(0, [text2]);
      doc.insert(doc.length, [para2]);
    }
  \`
});

═══════════════════════════════════════════════════════════════════════════
TIPS
═══════════════════════════════════════════════════════════════════════════

1. Always use toDelta() to extract text from Y.XmlText, not toString()
   toString() returns XML markup when text has formatting

2. Check instance types before operations:
   if (child instanceof Y.XmlElement) { ... }
   if (child instanceof Y.XmlText) { ... }

3. For hierarchical operations, use recursive functions to traverse the tree

4. All changes are batched in a single transaction - the entire script
   can be undone with one "undo" operation

5. If script fails mid-execution, all changes are automatically rolled back

6. Scripts run on the live document - changes sync to all users in real-time

7. REMOVING FORMATTING: Use { attribute: null }, NOT empty object {}

   ❌ WRONG - empty object does nothing:
     text.format(0, 5, {});  // No effect! Text stays bold

   ✅ CORRECT - explicitly set attribute to null:
     text.format(0, 5, { bold: null });     // Removes bold
     text.format(0, 5, { italic: null });   // Removes italic
     text.format(0, 5, { bold: null, italic: null });  // Removes both

8. IMPORTANT: When creating mixed formatting, ALWAYS pass {} for unformatted text

   ❌ WRONG - text inherits bold from previous insertion:
     text.insert(0, 'BOLD', { bold: true });
     text.insert(4, ' normal');  // Inherits bold!

   ✅ CORRECT - explicitly clear formatting with empty object:
     text.insert(0, 'BOLD', { bold: true });
     text.insert(4, ' normal', {});  // No formatting

   ✅ ALSO CORRECT - insert plain text first, then format:
     text.insert(0, 'BOLD normal');
     text.format(0, 4, { bold: true });  // Only format 'BOLD'

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
    const blocks = doc.toArray();
    const firstPara = blocks[0]; // Get existing paragraph

    // Try to move it to a list (this won't work as expected)
    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    item.insert(0, [firstPara]);  // ❌ Element still belongs to doc!

    doc.insert(1, [list]);
  }

✅ CORRECT - Delete from old location, create new structure:
  export default function edit(doc) {
    const blocks = doc.toArray();
    const firstPara = blocks[0];

    // Clone the element to preserve its content
    const clonedPara = firstPara.clone();

    // Delete from original location
    doc.delete(0, 1);

    // Create new structure with cloned content
    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    item.insert(0, [clonedPara]);
    list.insert(0, [item]);

    doc.insert(0, [list]);
  }

✅ ALSO CORRECT - Extract content and rebuild:
  export default function edit(doc) {
    const blocks = doc.toArray();
    const firstPara = blocks[0];

    // Extract text content
    const textNode = firstPara.get(0);
    const textContent = textNode instanceof Y.XmlText
      ? textNode.toDelta().map(op => typeof op.insert === 'string' ? op.insert : '').join('')
      : '';

    // Delete original
    doc.delete(0, 1);

    // Create new structure with same content
    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    const newPara = new Y.XmlElement('paragraph');
    const newText = new Y.XmlText();
    newText.insert(0, textContent);
    newPara.insert(0, [newText]);
    item.insert(0, [newPara]);
    list.insert(0, [item]);

    doc.insert(0, [list]);
  }

⚠️ PITFALL 2: Using Empty Object {} to Remove Formatting

PROBLEM: An empty object {} in format() does NOT remove formatting - it leaves
the text unchanged. To remove formatting, you must explicitly set each attribute
to null.

❌ WRONG - empty object has no effect:
  export default function edit(doc) {
    const text = findTextNode(doc.get(0));
    const content = extractText(text);
    // This does NOTHING - bold text stays bold
    text.format(0, content.length, {});
  }

✅ CORRECT - set attribute to null:
  export default function edit(doc) {
    const text = findTextNode(doc.get(0));
    const content = extractText(text);
    // This removes bold formatting
    text.format(0, content.length, { bold: null });
  }

✅ CORRECT - remove multiple attributes:
  export default function edit(doc) {
    const text = findTextNode(doc.get(0));
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
  const warnings = validateScript(script);

  // Validate timeout
  const validatedTimeout = Math.max(100, Math.min(30000, timeout));

  // Get or create session (establishes WebSocket presence)
  // Use 5 minute timeout to match open_document
  // This ensures cursor persists across multiple modify calls
  const session = await agentPresence.getOrCreateSession(
    docGuid,
    agentToken,
    300 // 5 minute session duration
  );

  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  try {
    // Execute the script
    const result = await executeScript(script, session, xmlFragment, {
      timeout: validatedTimeout,
    });

    if (result.success) {
      return {
        success: true,
        operationCount: result.operationCount,
        summary: result.summary,
      };
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
