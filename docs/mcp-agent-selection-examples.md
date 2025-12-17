# Agent Selection Examples

This document shows practical examples of using the `set_agent_selection` MCP tool to highlight text in documents.

## Overview

The `set_agent_selection` tool allows AI agents to select and highlight text in a document, making their selection visible to all connected users. This is useful for:

- Drawing attention to specific content during analysis
- Highlighting areas being edited or reviewed
- Indicating what the agent is currently working on
- Collaborative document review and annotation

## Basic Usage

### Example 1: Highlight a specific paragraph

```javascript
// First, get the document to find the position
const doc = await get_document({ docGuid: "abc-123" });

// Let's say we want to highlight the second paragraph
// Assuming the first paragraph is "Hello world." (12 chars + newline)
// The second paragraph starts at position 13

await set_agent_selection({
  docGuid: "abc-123",
  from: 13,
  to: 50,  // Highlight 37 characters
  durationSeconds: 60
});

// Response:
{
  "success": true,
  "message": "Agent selection set from position 13 to 50",
  "sessionId": "agent-selection-1234567890-abc123",
  "expiresIn": 60,
  "selection": { "from": 13, "to": 50 },
  "agent": {
    "name": "AI Assistant",
    "color": "hsl(120, 70%, 50%)"
  }
}
```

### Example 2: Place cursor at a specific position

```javascript
// Set from = to to show just a cursor position
await set_agent_selection({
  docGuid: "abc-123",
  from: 25,
  to: 25,  // Same as from = cursor position
  durationSeconds: 30
});
```

### Example 3: Highlight multiple sections sequentially

```javascript
// Highlight introduction (0-100 chars)
await set_agent_selection({
  docGuid: "abc-123",
  from: 0,
  to: 100,
  durationSeconds: 45
});

// Wait a bit, then highlight conclusion (last 200 chars)
await sleep(2000);

const doc = await get_document({ docGuid: "abc-123" });
const contentLength = doc.content.length;

await set_agent_selection({
  docGuid: "abc-123",
  from: contentLength - 200,
  to: contentLength,
  durationSeconds: 45
});
```

## Advanced Usage Patterns

### Example 4: Review workflow - highlight sections being analyzed

```javascript
async function reviewDocument(docGuid) {
  // Get the document
  const doc = await get_document({ docGuid });

  // Split into sections (simple example - split by double newline)
  const sections = doc.content.split('\n\n');
  let currentPos = 0;

  for (const section of sections) {
    // Highlight the current section being reviewed
    await set_agent_selection({
      docGuid,
      from: currentPos,
      to: currentPos + section.length,
      durationSeconds: 30
    });

    // Analyze the section
    console.log(`Reviewing section at position ${currentPos}...`);
    // ... perform analysis ...

    // Move to next section
    currentPos += section.length + 2; // +2 for '\n\n'

    // Wait a bit before moving to next section
    await sleep(2000);
  }
}
```

### Example 5: Collaborative editing - show what's being changed

```javascript
async function editSection(docGuid, searchText, replacement) {
  // Get document
  const doc = await get_document({ docGuid });

  // Find the text to replace
  const startPos = doc.content.indexOf(searchText);
  if (startPos === -1) {
    throw new Error('Text not found');
  }

  // Highlight the section being edited
  await set_agent_selection({
    docGuid,
    from: startPos,
    to: startPos + searchText.length,
    durationSeconds: 60
  });

  // Notify user
  console.log(`Editing text at position ${startPos}...`);

  // Perform the edit
  // ... update document ...
}
```

### Example 6: Search and highlight results

```javascript
async function highlightSearchTerm(docGuid, searchTerm) {
  const doc = await get_document({ docGuid });

  // Find the first occurrence
  const pos = doc.content.indexOf(searchTerm);

  if (pos === -1) {
    console.log('Search term not found');
    return;
  }

  // Highlight the found term
  await set_agent_selection({
    docGuid,
    from: pos,
    to: pos + searchTerm.length,
    durationSeconds: 90
  });

  console.log(`Found "${searchTerm}" at position ${pos}`);
}
```

### Example 7: Progressive reading indicator

```javascript
async function progressiveRead(docGuid, chunkSize = 100) {
  const doc = await get_document({ docGuid });
  const contentLength = doc.content.length;

  let currentPos = 0;

  while (currentPos < contentLength) {
    const endPos = Math.min(currentPos + chunkSize, contentLength);

    // Show reading progress
    await set_agent_selection({
      docGuid,
      from: currentPos,
      to: endPos,
      durationSeconds: 20
    });

    // Process this chunk
    const chunk = doc.content.substring(currentPos, endPos);
    console.log('Processing chunk:', chunk.substring(0, 50) + '...');

    // Move to next chunk
    currentPos = endPos;

    // Brief pause between chunks
    await sleep(1500);
  }
}
```

## Combining with Other MCP Tools

### Example 8: Read, highlight, and edit

```javascript
async function reviewAndEdit(docGuid) {
  // 1. Get the document
  const doc = await get_document({ docGuid });

  // 2. Find content that needs editing
  const errorText = "teh quick brown fox";
  const correctedText = "the quick brown fox";
  const pos = doc.content.indexOf(errorText);

  if (pos === -1) return;

  // 3. Highlight the error
  await set_agent_selection({
    docGuid,
    from: pos,
    to: pos + errorText.length,
    durationSeconds: 60
  });

  // 4. Show what we found
  console.log(`Found typo at position ${pos}: "${errorText}"`);

  // 5. Make the correction
  await update_document({
    docGuid,
    operation: 'replace',
    content: doc.content.replace(errorText, correctedText)
  });

  console.log('Typo corrected!');
}
```

### Example 9: Document structure analysis

```javascript
async function analyzeStructure(docGuid) {
  const doc = await get_document({ docGuid, format: 'structured' });

  // Find all headings
  for (let i = 0; i < doc.content.length; i++) {
    const node = doc.content[i];

    if (node.type === 'heading') {
      // Calculate position by summing previous nodes
      let position = 0;
      for (let j = 0; j < i; j++) {
        position += calculateNodeLength(doc.content[j]);
      }

      const headingLength = node.content.length;

      // Highlight each heading briefly
      await set_agent_selection({
        docGuid,
        from: position,
        to: position + headingLength,
        durationSeconds: 15
      });

      console.log(`Heading ${node.level}: "${node.content}"`);

      await sleep(1000);
    }
  }
}

function calculateNodeLength(node) {
  // Helper to calculate character length of a node
  if (typeof node.content === 'string') {
    return node.content.length + 1; // +1 for newline
  }
  // ... handle other node types ...
}
```

## Best Practices

### Duration Guidelines

- **Quick highlights (10-20s)**: Use when showing multiple items in sequence
- **Standard highlights (30-60s)**: Use for drawing attention during analysis
- **Extended highlights (90-120s)**: Use when user needs time to review
- **Maximum duration (300s)**: For important sections that need persistent attention

### Position Calculation Tips

1. **Use get_document first**: Always fetch the current document to calculate positions accurately
2. **Account for formatting**: In plain text mode, remember formatting like newlines
3. **Handle edge cases**: Check that positions are within document bounds
4. **Unicode considerations**: Multi-byte characters count as single positions

### Coordination with Users

1. **Announce selections**: Log or notify what you're highlighting and why
2. **Use appropriate duration**: Don't keep selections visible too long
3. **Clear before exiting**: Selections auto-clear after duration, but consider clearing explicitly if done early
4. **Multiple agents**: Be aware that multiple agents can have selections active simultaneously

## Troubleshooting

### Selection not visible

1. **Check permissions**: Agent must have at least viewer access to the document
2. **Verify positions**: Ensure `from` and `to` are within document bounds
3. **Connection issues**: WebSocket connection must be established successfully

### Position calculation errors

```javascript
// WRONG - Don't hardcode positions
await set_agent_selection({
  docGuid,
  from: 100,
  to: 200  // Position might not exist!
});

// RIGHT - Calculate based on actual content
const doc = await get_document({ docGuid });
const searchText = "important section";
const pos = doc.content.indexOf(searchText);

if (pos !== -1) {
  await set_agent_selection({
    docGuid,
    from: pos,
    to: pos + searchText.length
  });
}
```

### Multiple selections

Currently, each agent can have one active selection per document. Calling `set_agent_selection` again will create a new session, and the previous one will expire based on its duration.

## Future Enhancements

Potential future features:

- Multiple simultaneous selections per agent
- Named selections that can be updated
- Selection styles (highlight, underline, border)
- Persistent selections across sessions
- Selection annotations/comments
