# Deleting Empty Blocks with MCP Tools

This guide explains how to delete empty blocks (like empty lists) from documents using the MCP editing tools.

## What is an Empty Block?

An empty block is a structural element (like a `bulletList`, `orderedList`, or `paragraph`) that contains no visible text content. For example:

```json
{
  "type": "bulletList",
  "children": [
    {
      "type": "listItem",
      "children": [
        {
          "type": "paragraph",
          "content": ""
        }
      ]
    }
  ]
}
```

## How to Delete Empty Blocks

### Step 1: Read the Document

First, read the document to identify empty blocks:

```javascript
const result = await read_document({
  docGuid: "your-doc-guid",
  format: "structured"
});
```

Look for blocks with no `content` field or empty `content: ""`.

### Step 2: Navigate to the Empty Block

Use the `goto` tool to position the cursor at the empty block:

```javascript
await goto({
  docGuid: "your-doc-guid",
  target: {
    type: "block",
    index: 4  // The index of the empty block
  }
});
```

### Step 3: Delete the Empty Block

Use the `delete` tool with `unit: "block"` to remove the entire block:

```javascript
const deleteResult = await delete({
  docGuid: "your-doc-guid",
  unit: "block",
  direction: "forward"  // direction doesn't matter for empty blocks
});
```

**Note**: When deleting an empty block, the `direction` parameter is ignored. The tool automatically detects that the current block is empty and removes it immediately.

### Expected Result

If the block was empty and successfully deleted, you'll receive:

```json
{
  "success": true,
  "deletedText": "",
  "deletedLength": 0,
  "deletedBlock": true,
  "cursor": {
    "block": 3,
    "offset": 0,
    "blockType": "paragraph"
  }
}
```

Note the `deletedBlock: true` field, which indicates that an entire block structure was removed (not just text content).

## Complete Example

Here's a complete workflow for identifying and removing an empty block:

```javascript
// 1. Open the document
await open_document({ docGuid: "abc-123" });

// 2. Read to identify empty blocks
const doc = await read_document({
  docGuid: "abc-123",
  format: "structured"
});

// Find empty blocks
const emptyBlockIndex = doc.content.findIndex(block => {
  // Check if block has no text content
  if (block.type === 'paragraph' && !block.content) return true;
  if (block.type === 'bulletList' || block.type === 'orderedList') {
    // Check if list has only empty items
    return block.children.every(item =>
      !item.children?.some(child => child.content)
    );
  }
  return false;
});

if (emptyBlockIndex >= 0) {
  // 3. Navigate to the empty block
  await goto({
    docGuid: "abc-123",
    target: { type: "block", index: emptyBlockIndex }
  });

  // 4. Delete it
  const result = await delete({
    docGuid: "abc-123",
    unit: "block",
    direction: "forward"
  });

  if (result.deletedBlock) {
    console.log(`Successfully deleted empty block at index ${emptyBlockIndex}`);
  }
}

// 5. Close when done
await close_document({ docGuid: "abc-123" });
```

## Important Notes

1. **Only empty blocks can be deleted this way**: If a block contains any text, the `delete` tool will delete the text content, not the block structure itself.

2. **Last block protection**: The delete tool will not remove the last block in a document, ensuring the document always has at least one block.

3. **Direction doesn't matter for empty blocks**: When deleting an empty block, the `direction` parameter ("forward" or "backward") doesn't affect the outcome since there's nowhere to move the cursor.

4. **Cursor repositioning**: After deleting a block, the cursor automatically moves to the previous block (or next block if at index 0).

## Alternative: Prevention

Instead of deleting empty blocks after creation, you can prevent them by:

- Using `insert_block` with content instead of creating empty structures
- Checking block content before insertion
- Using the structured document editing tools carefully

## Troubleshooting

**Problem**: Delete returns `deletedLength: 0` and `deletedBlock: false`

**Solution**: The block is not empty. Check its content using `read_document` with `format: "structured"` to see what text exists in the block.

**Problem**: Delete fails with "Document must have at least one block"

**Solution**: You're trying to delete the only block in the document. Add a new block first before deleting the empty one.

**Problem**: Can't find the empty block

**Solution**: Use `read_document` with `format: "structured"` to see the exact block structure and indices.
