/**
 * execute_script MCP Tool
 *
 * Execute a TypeScript script to edit a document.
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
const name = 'execute_script';

const description = `Execute a TypeScript script to edit the document.

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
BEST PRACTICES
═══════════════════════════════════════════════════════════════════════════

❌ DON'T: Rewrite entire documents from scratch
  - Deleting all blocks and recreating the document is inefficient
  - Breaks real-time collaboration (other users see flickering)
  - Loses document history and undo/redo state
  - Increases network traffic and operation count

✅ DO: Make targeted modifications to existing content
  - Find specific blocks/text and modify them in place
  - Insert new content where needed, delete only what's necessary
  - Use format() to change styling without rewriting text
  - Break large tasks into logical chunks (one script per logical change)

Examples:
  ❌ Bad: Delete all blocks, recreate entire document with changes
  ✅ Good: Find headings, update their level attribute
  ✅ Good: Find TODO items, format them as bold
  ✅ Good: Insert new section at specific location

When working on large documents:
  - Break work into multiple execute_script calls (one per section/task)
  - Each script should have a single, clear purpose
  - Preserve existing content that doesn't need changes

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
await execute_script({
  docGuid: "abc-123",
  script: \`
    export default function edit(doc) {
      function findTextNode(element) {
        for (const child of element.toArray()) {
          if (child instanceof Y.XmlText) return child;
          if (child instanceof Y.XmlElement) {
            const found = findTextNode(child);
            if (found) return found;
          }
        }
        return null;
      }

      function extractText(xmlText) {
        const delta = xmlText.toDelta();
        return delta.map(op => typeof op.insert === 'string' ? op.insert : '').join('');
      }

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
await execute_script({
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
await execute_script({
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
await execute_script({
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
await execute_script({
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

7. IMPORTANT: When creating mixed formatting, ALWAYS pass {} for unformatted text

   ❌ WRONG - text inherits bold from previous insertion:
     text.insert(0, 'BOLD', { bold: true });
     text.insert(4, ' normal');  // Inherits bold!

   ✅ CORRECT - explicitly clear formatting with empty object:
     text.insert(0, 'BOLD', { bold: true });
     text.insert(4, ' normal', {});  // No formatting

   ✅ ALSO CORRECT - insert plain text first, then format:
     text.insert(0, 'BOLD normal');
     text.format(0, 4, { bold: true });  // Only format 'BOLD'
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
  // This ensures cursor persists across multiple execute_script calls
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
      animate: true,
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
