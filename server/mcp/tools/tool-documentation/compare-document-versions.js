/**
 * Full scripting API reference for the compare_document_versions tool.
 *
 * Served on demand via the get_tool_documentation MCP tool and passed in full
 * to the in-app chat agent (chatDescription). The MCP-facing description of
 * compare_document_versions is a short summary because clients such as
 * Claude Code truncate tool descriptions at 2KB.
 */

const COMPARE_DOCUMENTATION = `Compare two document versions using a TypeScript script.

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

Your script receives two Y.XmlFragment objects (ephemeral snapshots):
- doc1: Document at versionId1
- doc2: Document at versionId2

Return any data you want - the tool will return it to you.

Script structure:
  export default function compare(doc1: Y.XmlFragment, doc2: Y.XmlFragment) {
    // Your comparison logic here
    return { ... };
  }

Note: Documents are temporary snapshots loaded from version history.
Any modifications won't persist (but there's no need to modify for comparison).

═══════════════════════════════════════════════════════════════════════════
HELPER FUNCTIONS
═══════════════════════════════════════════════════════════════════════════

Text extraction:
- extractPlainText(doc) - Get all text from document
- extractText(xmlText) - Get text from Y.XmlText node
- findTextNode(element) - Find first text node in element

Finding elements:
- xpath('//heading[@level="1"]') - Query with XPath
- xpath('//heading', contextNode) - Query within specific node
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
  const title1 = xpath('//heading[@level="1"]', doc1)[0];
  const title2 = xpath('//heading[@level="1"]', doc2)[0];

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
`;

module.exports = { COMPARE_DOCUMENTATION };
