# Plan: compare_document_versions Tool

## Overview

Create a new MCP tool that allows agents to programmatically compare two document versions using TypeScript. Instead of providing a fixed diff format, this tool gives agents a sandboxed TypeScript environment with access to both Y.Doc versions, allowing them to write custom comparison logic for their specific needs.

This adds 1 new tool, bringing the total to **22 MCP tools**.

## Motivation

Traditional diff tools provide a fixed format (added lines, removed lines, etc.), but agents often need:
- **Specific information**: "Did the title change?" not "here's every character difference"
- **Structural analysis**: "How many new sections were added?" not character-by-character diff
- **Semantic comparisons**: "Were any links added?" or "Did the conclusion change?"
- **Custom logic**: "Find paragraphs that mention 'budget' in version 2 but not version 1"

By providing a programmable comparison environment, agents can extract exactly the information they need.

## Similar Pattern: modify Tool

This follows the same pattern as the existing `modify` tool:
- TypeScript sandbox with Y.js API access
- Helper functions available globally
- Timeout and security controls
- Clear error handling

**Key difference:** `compare_document_versions` is **read-only** and returns analysis data instead of modifying the document.

## Tool Specification

**Tool Name:** `compare_document_versions`

**Parameters:**
```typescript
{
  docGuid: string;        // Document UUID (required)
  versionId1: string;     // First version to compare (required)
                          // Can be UUID, "auto-{clock}", or "clock-{clock}"
  versionId2: string;     // Second version to compare (required)
                          // Can be UUID, "auto-{clock}", or "clock-{clock}"
  script: string;         // TypeScript code to execute (required)
  timeout?: number;       // Execution timeout in milliseconds (optional, default: 5000, max: 30000)
}
```

**Returns:**
```typescript
{
  success: boolean;
  result: any;            // Value returned by the script
  executionTime: number;  // Milliseconds taken to execute
  error?: string;         // Error message if failed
}
```

**Error Cases:**
| Scenario | Error Message |
|----------|---------------|
| Document not found | `Document not found or you do not have access` |
| versionId1 not found | `Version 1 not found: {versionId1}` |
| versionId2 not found | `Version 2 not found: {versionId2}` |
| Invalid script | `Script compilation failed: {details}` |
| Script timeout | `Script execution timed out after {timeout}ms` |
| Script runtime error | `Script execution failed: {error}` |
| Timeout too large | `Timeout cannot exceed 30000ms` |

## Script Environment

### Available Variables

Scripts receive two Y.Doc fragments as read-only variables:

```typescript
export default function compare(doc1: Y.XmlFragment, doc2: Y.XmlFragment) {
  // doc1 - Document at versionId1 (read-only)
  // doc2 - Document at versionId2 (read-only)

  // Return any data you want
  return { ... };
}
```

### Built-in Helper Functions

All helper functions from the `modify` tool are available in read-only mode:

**Text Extraction:**
```typescript
findTextNode(element: Y.XmlElement): Y.XmlText | null
  - Find first Y.XmlText node in element (recursive)
  - Returns Y.XmlText or null

extractText(xmlText: Y.XmlText): string
  - Extract plain text from Y.XmlText using toDelta()
  - Use this instead of toString() for formatted text

extractPlainText(element: Y.XmlElement | Y.XmlFragment): string
  - Extract all text from element, including nested elements
  - Returns concatenated plain text
```

**Finding Elements:**
```typescript
findByText(doc: Y.XmlFragment, searchText: string): Y.XmlElement | null
  - Find first element containing text (case-insensitive)
  - Returns element or null

findAllByText(doc: Y.XmlFragment, searchText: string): Y.XmlElement[]
  - Find all elements containing text (case-insensitive)
  - Returns array of elements

xpath(doc: Y.XmlFragment, xpathExpr: string): Y.XmlElement[]
  - Query elements using XPath expressions
  - Example: xpath(doc, '//heading[@level="1"]')
```

**Element Properties:**
```typescript
getAttributes(element: Y.XmlElement): Record<string, any>
  - Get all attributes as object
  - Example: { level: "1", id: "intro" }

hasAttribute(element: Y.XmlElement, name: string, value?: string): boolean
  - Check if element has attribute (optionally with specific value)
```

**New: Comparison Helpers**

Additional helpers specific to comparison:

```typescript
getBlockCount(doc: Y.XmlFragment): number
  - Count total blocks in document
  - Returns number

getWordCount(doc: Y.XmlFragment): number
  - Count total words in document
  - Returns number

getCharacterCount(doc: Y.XmlFragment): number
  - Count total characters in document
  - Returns number

getElementByType(doc: Y.XmlFragment, type: string): Y.XmlElement[]
  - Get all elements of specific type
  - Example: getElementByType(doc, 'heading')

extractLinks(doc: Y.XmlFragment): Array<{ text: string, href: string }>
  - Extract all links from document
  - Returns array of { text, href } objects
```

### Limitations

**Read-only environment:**
- Cannot modify doc1 or doc2
- Attempting to modify throws error: "Cannot modify documents in comparison mode"
- No persistence - this is purely for analysis

**Security:**
- Sandboxed execution (no fs, net, require access)
- Timeout enforced (default 5s, max 30s)
- Memory limits enforced
- No side effects outside the comparison

## Use Cases

### 1. Text Changes
```typescript
export default function compare(doc1: Y.XmlFragment, doc2: Y.XmlFragment) {
  const text1 = extractPlainText(doc1);
  const text2 = extractPlainText(doc2);

  return {
    added: text2.length - text1.length,
    charactersInV1: text1.length,
    charactersInV2: text2.length,
    textAdded: text2.length > text1.length
  };
}
```

### 2. Structural Changes
```typescript
export default function compare(doc1: Y.XmlFragment, doc2: Y.XmlFragment) {
  const headings1 = xpath(doc1, '//heading');
  const headings2 = xpath(doc2, '//heading');

  return {
    headingsAdded: headings2.length - headings1.length,
    totalHeadingsV1: headings1.length,
    totalHeadingsV2: headings2.length
  };
}
```

### 3. Content Analysis
```typescript
export default function compare(doc1: Y.XmlFragment, doc2: Y.XmlFragment) {
  const title1 = xpath(doc1, '//heading[@level="1"]')[0];
  const title2 = xpath(doc2, '//heading[@level="1"]')[0];

  const titleText1 = title1 ? extractPlainText(title1) : '';
  const titleText2 = title2 ? extractPlainText(title2) : '';

  return {
    titleChanged: titleText1 !== titleText2,
    oldTitle: titleText1,
    newTitle: titleText2
  };
}
```

### 4. Link Tracking
```typescript
export default function compare(doc1: Y.XmlFragment, doc2: Y.XmlFragment) {
  const links1 = extractLinks(doc1);
  const links2 = extractLinks(doc2);

  const newLinks = links2.filter(l2 =>
    !links1.some(l1 => l1.href === l2.href)
  );

  return {
    linksAdded: newLinks.length,
    newLinks: newLinks,
    totalLinksV1: links1.length,
    totalLinksV2: links2.length
  };
}
```

### 5. Finding Specific Changes
```typescript
export default function compare(doc1: Y.XmlFragment, doc2: Y.XmlFragment) {
  const budgetMentions1 = findAllByText(doc1, 'budget');
  const budgetMentions2 = findAllByText(doc2, 'budget');

  return {
    budgetMentionsAdded: budgetMentions2.length - budgetMentions1.length,
    mentionsV1: budgetMentions1.length,
    mentionsV2: budgetMentions2.length
  };
}
```

### 6. List Analysis
```typescript
export default function compare(doc1: Y.XmlFragment, doc2: Y.XmlFragment) {
  const listItems1 = xpath(doc1, '//listItem');
  const listItems2 = xpath(doc2, '//listItem');

  return {
    itemsAdded: listItems2.length - listItems1.length,
    totalItemsV1: listItems1.length,
    totalItemsV2: listItems2.length,
    items: listItems2.map(item => extractPlainText(item))
  };
}
```

## Implementation

### File Structure

**Create:**
- `server/mcp/tools/compare-document-versions.js` - Main tool file

**Modify:**
- `server/mcp/index.js` - Register new tool
- `server/mcp/sandbox/helpers.js` - Add new comparison helpers
- `server/mcp/sandbox/executor.js` - Add read-only mode support (if needed)

### Backend Logic

**File:** `server/mcp/tools/compare-document-versions.js`

```javascript
const versionHistory = require('../../version-history');
const { executeComparisonScript } = require('../sandbox');

async function handler(args, agentToken) {
  const { docGuid, versionId1, versionId2, script, timeout = 5000 } = args;
  const userId = agentToken.userId;

  // Validate timeout
  if (timeout > 30000) {
    throw new Error('Timeout cannot exceed 30000ms');
  }

  // Check document access (any role - read-only operation)
  const access = await checkDocumentAccess(docGuid, userId);
  if (!access) {
    throw new Error('Document not found or you do not have access');
  }

  // Load both versions
  let doc1, doc2;
  try {
    const content1 = await versionHistory.getVersionContent(
      persistenceProvider,
      docGuid,
      versionId1
    );
    doc1 = content1.doc; // Y.Doc instance
  } catch (error) {
    throw new Error(`Version 1 not found: ${versionId1}`);
  }

  try {
    const content2 = await versionHistory.getVersionContent(
      persistenceProvider,
      docGuid,
      versionId2
    );
    doc2 = content2.doc; // Y.Doc instance
  } catch (error) {
    throw new Error(`Version 2 not found: ${versionId2}`);
  }

  // Execute comparison script
  const startTime = Date.now();
  try {
    const result = await executeComparisonScript(
      script,
      doc1.get('default', Y.XmlFragment),
      doc2.get('default', Y.XmlFragment),
      { timeout }
    );

    return {
      success: true,
      result: result,
      executionTime: Date.now() - startTime
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      executionTime: Date.now() - startTime
    };
  }
}
```

### Sandbox Enhancement

**File:** `server/mcp/sandbox/index.js`

Add new function `executeComparisonScript`:

```javascript
/**
 * Execute a TypeScript comparison script in read-only mode
 *
 * @param {string} tsScript - TypeScript source code
 * @param {Y.XmlFragment} doc1 - First document version
 * @param {Y.XmlFragment} doc2 - Second document version
 * @param {object} options - Execution options
 * @param {number} [options.timeout=5000] - Execution timeout
 * @returns {Promise<any>} - Value returned by the script
 */
async function executeComparisonScript(tsScript, doc1, doc2, options = {}) {
  const { timeout = 5000 } = options;

  // Compile TypeScript
  const jsCode = compileTypeScript(tsScript);

  // Wrap documents in read-only proxy (prevent modifications)
  const readOnlyDoc1 = makeReadOnly(doc1);
  const readOnlyDoc2 = makeReadOnly(doc2);

  // Execute in sandbox
  const result = await executeSandboxed(jsCode, {
    doc1: readOnlyDoc1,
    doc2: readOnlyDoc2,
    // Include all helper functions
    ...helpers
  }, { timeout });

  return result;
}

/**
 * Wrap Y.js object in read-only proxy
 */
function makeReadOnly(obj) {
  return new Proxy(obj, {
    set() {
      throw new Error('Cannot modify documents in comparison mode');
    },
    get(target, prop) {
      const value = target[prop];

      // Intercept mutation methods
      if (typeof value === 'function') {
        const mutationMethods = ['insert', 'delete', 'push', 'unshift', 'setAttribute'];
        if (mutationMethods.includes(prop)) {
          return () => {
            throw new Error('Cannot modify documents in comparison mode');
          };
        }
      }

      return value;
    }
  });
}
```

### New Helper Functions

**File:** `server/mcp/sandbox/helpers.js`

Add comparison-specific helpers:

```javascript
/**
 * Get total block count in document
 */
function getBlockCount(doc) {
  return doc.length;
}

/**
 * Get total word count in document
 */
function getWordCount(doc) {
  const text = extractPlainText(doc);
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Get total character count in document
 */
function getCharacterCount(doc) {
  return extractPlainText(doc).length;
}

/**
 * Get all elements of specific type
 */
function getElementByType(doc, type) {
  const results = [];
  for (let i = 0; i < doc.length; i++) {
    const child = doc.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === type) {
      results.push(child);
    }
  }
  return results;
}

/**
 * Extract all links from document
 */
function extractLinks(doc) {
  const links = [];

  function traverse(element) {
    if (element instanceof Y.XmlElement) {
      // Check if this element has a link mark
      const textNode = findTextNode(element);
      if (textNode) {
        const delta = textNode.toDelta();
        delta.forEach(op => {
          if (op.attributes && op.attributes.link) {
            links.push({
              text: op.insert,
              href: op.attributes.link
            });
          }
        });
      }

      // Recurse into children
      for (let i = 0; i < element.length; i++) {
        traverse(element.get(i));
      }
    } else if (element instanceof Y.XmlFragment) {
      for (let i = 0; i < element.length; i++) {
        traverse(element.get(i));
      }
    }
  }

  traverse(doc);
  return links;
}

module.exports = {
  // ... existing helpers
  getBlockCount,
  getWordCount,
  getCharacterCount,
  getElementByType,
  extractLinks
};
```

## Permissions

- Any role can compare versions (viewer, editor, owner)
- Read-only operation
- Same access rules as `read_document_version`
- No persistence or side effects

## Testing

### Unit Tests

**Script compilation:**
- ✅ Valid TypeScript compiles successfully
- ✅ Invalid TypeScript → compilation error with details
- ✅ Script with syntax errors → helpful error message

**Script execution:**
- ✅ Simple comparison returns correct result
- ✅ Script timeout → error after specified time
- ✅ Script runtime error → error with stack trace
- ✅ Script returning different data types (object, array, string, number, boolean)

**Read-only enforcement:**
- ✅ Attempting to insert → error "Cannot modify documents in comparison mode"
- ✅ Attempting to delete → error "Cannot modify documents in comparison mode"
- ✅ Attempting to setAttribute → error "Cannot modify documents in comparison mode"
- ✅ Reading operations work normally

**Helper functions:**
- ✅ getBlockCount returns correct count
- ✅ getWordCount returns correct count
- ✅ getCharacterCount returns correct count
- ✅ getElementByType finds correct elements
- ✅ extractLinks finds all links with text and href
- ✅ All existing helpers work (findTextNode, extractText, etc.)

**Version loading:**
- ✅ Both versions load correctly
- ✅ versionId1 not found → error
- ✅ versionId2 not found → error
- ✅ Works with UUID versions
- ✅ Works with auto-{clock} versions
- ✅ Works with clock-{clock} versions

**Error cases:**
- ✅ Document not found
- ✅ No access to document
- ✅ Timeout too large (>30000ms)

### Integration Tests

- Create document, make changes, create two versions
- Compare versions with script that counts words → verify correct result
- Compare versions with script that finds headings → verify correct result
- Compare versions with script that extracts links → verify correct links
- Verify read-only: script tries to modify → error, documents unchanged
- Compare same version to itself → script returns no differences
- Complex script with loops and conditionals → executes correctly

### Manual Testing

**Natural language requests:**
- "Compare the last two versions and tell me if the title changed"
  → Agent writes script to check title text

- "Did any links get added between version 1 and version 2?"
  → Agent writes script to extract and compare links

- "How many new paragraphs were added in the latest version?"
  → Agent writes script to count paragraph elements

- "Show me what changed in the introduction section"
  → Agent writes script to find introduction heading and compare content

- "Were any TODO items removed?"
  → Agent writes script to find text containing "TODO" and compare counts

## Tool Description

The tool's `description` field should include:

```
═══════════════════════════════════════════════════════════════════════════
OVERVIEW
═══════════════════════════════════════════════════════════════════════════

Compare two document versions using a programmable TypeScript environment.
Instead of a fixed diff format, write custom comparison logic to extract
exactly the information you need.

Use cases:
- "Did the title change?" - Compare specific elements
- "How many sections were added?" - Count structural changes
- "Were any links added?" - Extract and compare links
- "Find paragraphs mentioning 'budget'" - Semantic search across versions

═══════════════════════════════════════════════════════════════════════════
SCRIPT ENVIRONMENT
═══════════════════════════════════════════════════════════════════════════

Your script receives two Y.XmlFragment objects (read-only):
- doc1: Document at versionId1
- doc2: Document at versionId2

Return any data you want - the tool will return it to you.

Script structure:
  export default function compare(doc1: Y.XmlFragment, doc2: Y.XmlFragment) {
    // Your comparison logic here
    return { ... };
  }

READ-ONLY: You cannot modify the documents. This is purely for analysis.

═══════════════════════════════════════════════════════════════════════════
HELPER FUNCTIONS
═══════════════════════════════════════════════════════════════════════════

Text extraction:
- extractPlainText(doc) - Get all text from document
- extractText(xmlText) - Get text from Y.XmlText node
- findTextNode(element) - Find first text node in element

Finding elements:
- xpath(doc, '//heading[@level="1"]') - Query with XPath
- findByText(doc, 'search text') - Find element containing text
- findAllByText(doc, 'search text') - Find all matching elements
- getElementByType(doc, 'heading') - Get all elements of type

Comparison helpers:
- getBlockCount(doc) - Count total blocks
- getWordCount(doc) - Count total words
- getCharacterCount(doc) - Count total characters
- extractLinks(doc) - Get all links [{text, href}, ...]

Element properties:
- getAttributes(element) - Get all attributes as object
- hasAttribute(element, name, value?) - Check if attribute exists

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Check if title changed
export default function compare(doc1, doc2) {
  const title1 = xpath(doc1, '//heading[@level="1"]')[0];
  const title2 = xpath(doc2, '//heading[@level="1"]')[0];

  return {
    titleChanged: extractPlainText(title1) !== extractPlainText(title2),
    oldTitle: extractPlainText(title1),
    newTitle: extractPlainText(title2)
  };
}

// Count new links
export default function compare(doc1, doc2) {
  const links1 = extractLinks(doc1);
  const links2 = extractLinks(doc2);

  const newLinks = links2.filter(l2 =>
    !links1.some(l1 => l1.href === l2.href)
  );

  return { linksAdded: newLinks.length, newLinks };
}

// Word count change
export default function compare(doc1, doc2) {
  return {
    wordsAdded: getWordCount(doc2) - getWordCount(doc1),
    wordsV1: getWordCount(doc1),
    wordsV2: getWordCount(doc2)
  };
}
```

## Documentation Updates

### README.md
- Update tool count: 21 → 22
- Add section about programmable version comparison
- Include example use case

### docs/mcp-integration-summary.md
- Update tool count: 21 → 22
- Add `compare_document_versions` to tools list
- Include examples showing different comparison scenarios
- Explain read-only nature and TypeScript environment

## Implementation Checklist

- [ ] Create `server/mcp/tools/compare-document-versions.js`
  - [ ] Implement handler with version loading
  - [ ] Add input schema validation
  - [ ] Write comprehensive description
  - [ ] Add examples showing various comparison patterns
- [ ] Update `server/mcp/sandbox/index.js`
  - [ ] Add `executeComparisonScript` function
  - [ ] Implement read-only proxy wrapper `makeReadOnly`
  - [ ] Export new function
- [ ] Update `server/mcp/sandbox/helpers.js`
  - [ ] Add `getBlockCount` helper
  - [ ] Add `getWordCount` helper
  - [ ] Add `getCharacterCount` helper
  - [ ] Add `getElementByType` helper
  - [ ] Add `extractLinks` helper
  - [ ] Export new helpers
- [ ] Update `server/mcp/index.js`
  - [ ] Register `compare_document_versions` tool
- [ ] Write unit tests
  - [ ] Test script compilation and execution
  - [ ] Test read-only enforcement
  - [ ] Test helper functions
  - [ ] Test version loading
  - [ ] Test error cases
- [ ] Add integration tests
  - [ ] Test real document comparisons
  - [ ] Test various script patterns
  - [ ] Verify read-only guarantees
- [ ] Update README.md
- [ ] Update docs/mcp-integration-summary.md

## Estimated Time

**~3 hours** including implementation, tests, and documentation

## Security Considerations

- Read-only environment prevents accidental modifications
- Sandboxed execution (no fs, net, require access)
- Timeout prevents infinite loops
- Memory limits enforced
- No persistence or side effects
- Same permission checks as read_document_version

## Future Enhancements

Once this tool is implemented, consider:

1. **Diff helpers** - Pre-built helpers for common diff patterns (text diff, block diff)
2. **Performance optimization** - Cache compiled scripts for repeated comparisons
3. **Structured diff output** - Helper to generate standardized diff format if needed
4. **Three-way comparison** - Compare three versions for merge conflict analysis
5. **Statistical analysis** - Helpers for change velocity, author attribution, etc.
