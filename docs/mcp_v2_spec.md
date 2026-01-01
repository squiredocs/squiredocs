# MCP v2 API Specification: Cursor-Based Document Editing

## Overview

This document specifies a redesigned MCP (Model Context Protocol) API for AI agent document editing. The key innovation is a **cursor-based approach** that mimics how human editors interact with documents, replacing the current position/offset-based API.

### Motivation

The current MCP API requires tracking absolute character offsets and block indices:
- `insert_text`: requires `elementIndex` + `characterPosition`
- `apply_marks`: requires `elementIndex` + `startPosition` + `endPosition`
- `select_text_range`: requires `anchorPos` + `headPos`

**Problems with this approach:**
1. Offsets become stale when the document changes (concurrent edits)
2. Requires repeatedly refetching document structure
3. Error-prone offset calculations
4. Doesn't match how human editors work
5. Poor collaboration experience (can't "watch" the AI work naturally)

### Philosophy

The cursor-based API mimics the interactive collaborative experience of multiple users using the editor together:
- Agents have a visible cursor, just like human users
- Users can watch the agent navigate, select, and edit
- Operations are relative to cursor position, not absolute offsets
- Cursor positions automatically adjust when others edit (via Yjs CRDTs)

---

## 1. Core Concepts

### 1.1 Agent Session

An agent's active presence in a document. Lifecycle:
- **Created** when agent first interacts with a document (`open_document`)
- **Persists** across tool calls while agent is "active" (configurable timeout)
- **Destroyed** when agent explicitly leaves (`close_document`) or times out

Session state includes:
- Cursor position (Yjs RelativePosition)
- Selection anchor (Yjs RelativePosition, or null if no selection)
- UndoManager instance
- Awareness presence (name, color, cursor visibility)

### 1.2 Cursor Model

```
┌─────────────────────────────────────────────────┐
│  Collapsed cursor (no selection):               │
│                                                 │
│  "The quick brown fox"                          │
│            │                                    │
│            └── cursor (anchor = head)           │
├─────────────────────────────────────────────────┤
│  Extended selection:                            │
│                                                 │
│  "The quick brown fox"                          │
│      ├─────────┤                                │
│      │         └── head (cursor position)       │
│      └── anchor (selection start)               │
│                                                 │
│  Selected text: "quick brown"                   │
└─────────────────────────────────────────────────┘
```

**Key properties:**
- `anchor`: Where selection started (fixed when extending)
- `head`: Current cursor position (moves during selection)
- When `anchor == head`: No selection (collapsed cursor)
- Selection direction matters: anchor→head can be forward or backward

### 1.3 Position Stability

Positions use **Yjs RelativePosition** internally, which means:
- Positions survive concurrent edits from other users
- No need to refetch/recalculate after operations
- The cursor "sticks" to its logical location in the text

### 1.4 One Cursor Per Agent

Each agent has exactly one cursor, just like human editors. This keeps the model simple and matches user expectations. (Multiple cursors could be explored in the future, similar to how humans can open multiple tabs.)

---

## 2. Session Lifecycle

```
┌────────────────────────────────────────────────────────────┐
│                     Session States                          │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌─────────┐    open_document    ┌────────┐               │
│  │ (none)  │ ─────────────────► │ Active │               │
│  └─────────┘                     └────────┘               │
│       ▲                              │                     │
│       │                              │ any tool call       │
│       │                              │ resets timeout      │
│       │         close_document       ▼                     │
│       │         or timeout      ┌────────┐               │
│       └──────────────────────── │ Active │               │
│                                 └────────┘               │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**Timeout behavior:**
- Each tool call resets the session timeout (default: 5 minutes)
- Session auto-closes after timeout (cursor disappears)
- Agent can explicitly close with `close_document`
- This mirrors human behavior: cursor disappears when user leaves the document

---

## 3. Tool Specifications

### 3.1 Session Management

#### `open_document`

Initialize agent session on a document.

```yaml
name: open_document
description: |
  Open a document and establish cursor presence.
  Cursor starts at document beginning.

parameters:
  docGuid: string (required) - Document UUID
  position: string (optional) - Initial position: "start" | "end" (default: "start")

returns:
  success: boolean
  sessionId: string
  documentInfo:
    title: string
    blockCount: number
    characterCount: number
  cursor:
    block: number - Current block index
    blockType: string - e.g., "paragraph", "heading"
    context: string - Text around cursor (50 chars before/after)
```

#### `close_document`

End agent session and remove presence.

```yaml
name: close_document
description: |
  Close the document session. Cursor disappears for other users.

parameters:
  docGuid: string (required)

returns:
  success: boolean
  message: string
```

---

### 3.2 Navigation

#### `goto`

Move cursor to a specific location.

```yaml
name: goto
description: |
  Move cursor to a specific location. Collapses any existing selection.

parameters:
  docGuid: string (required)
  target: object (required) - One of:
    - { type: "document_start" }
    - { type: "document_end" }
    - { type: "block", index: number }
    - { type: "block_start" } - Start of current block
    - { type: "block_end" } - End of current block
    - { type: "position", block: number, offset: number } - Specific position

returns:
  success: boolean
  cursor:
    block: number
    offset: number
    blockType: string
    context: string - Text around new cursor position
```

#### `move`

Move cursor relative to current position.

```yaml
name: move
description: |
  Move cursor forward or backward by units.
  Can optionally extend selection instead of moving.

parameters:
  docGuid: string (required)
  direction: "forward" | "backward" (required)
  unit: "char" | "word" | "block" (required)
  count: number (optional, default: 1)
  extend: boolean (optional, default: false) - Extend selection instead of moving

returns:
  success: boolean
  moved: number - Actual units moved (may be less if hit boundary)
  cursor:
    block: number
    offset: number
    context: string
  selection: object | null - If selection exists:
    text: string
    length: number
```

#### `find`

Search for text and optionally navigate to it.

```yaml
name: find
description: |
  Search for text from current cursor position.
  Can move cursor to match or select the match.

parameters:
  docGuid: string (required)
  query: string (required) - Text to search for
  options:
    direction: "forward" | "backward" (default: "forward")
    caseSensitive: boolean (default: false)
    regex: boolean (default: false)
    wrap: boolean (default: true) - Wrap around document
    action: "goto" | "select" | "peek" (default: "goto")
      # goto: Move cursor to start of match
      # select: Select the matched text
      # peek: Just return match info without moving

returns:
  success: boolean
  found: boolean
  match: object | null - If found:
    text: string
    block: number
    offset: number
    length: number
  cursor: object - Current cursor state (updated if action != "peek")
  selection: object | null - If action == "select"
```

---

### 3.3 Selection

#### `select`

Create or modify selection.

```yaml
name: select
description: |
  Create a selection. Various modes available.

parameters:
  docGuid: string (required)
  mode: string (required) - One of:
    - "none" - Collapse selection (deselect)
    - "word" - Select word at/around cursor
    - "block" - Select current block
    - "all" - Select entire document
    - "to_block_start" - From cursor to start of block
    - "to_block_end" - From cursor to end of block

returns:
  success: boolean
  selection:
    text: string
    length: number
    startBlock: number
    endBlock: number
  cursor: object - Updated cursor state
```

#### `get_selection`

Get current selection info.

```yaml
name: get_selection
description: |
  Get information about current cursor and selection.

parameters:
  docGuid: string (required)
  includeContext: boolean (optional, default: true) - Include surrounding text

returns:
  hasSelection: boolean
  selection: object | null
    text: string
    length: number
    startBlock: number
    startOffset: number
    endBlock: number
    endOffset: number
  cursor:
    block: number
    offset: number
    blockType: string
  context: object (if includeContext)
    before: string - 100 chars before selection/cursor
    after: string - 100 chars after selection/cursor
```

---

### 3.4 Editing

#### `insert`

Insert text at cursor position.

```yaml
name: insert
description: |
  Insert text at cursor. If selection exists, replaces selection.
  Cursor moves to end of inserted text.

  Supports streaming mode for character-by-character insertion
  visible to other users.

parameters:
  docGuid: string (required)
  text: string (required) - Text to insert
  marks: array (optional) - Formatting: ["bold", "italic", "underline", "strike"]
    or [{ type: "link", href: "url" }]
  streaming: boolean (optional, default: false) - Insert with typing animation

returns:
  success: boolean
  insertedLength: number
  replacedSelection: boolean
  cursor: object - New cursor position
```

#### `delete`

Delete text.

```yaml
name: delete
description: |
  Delete selected text, or delete characters from cursor.
  If no selection, deletes in specified direction.

parameters:
  docGuid: string (required)
  # If selection exists, these are ignored:
  direction: "forward" | "backward" (optional, default: "backward")
  unit: "char" | "word" | "block" (optional, default: "char")
  count: number (optional, default: 1)

returns:
  success: boolean
  deletedText: string
  deletedLength: number
  cursor: object - New cursor position
```

#### `format`

Apply or remove formatting to selection.

```yaml
name: format
description: |
  Apply or remove formatting marks to selected text.
  Requires an active selection.

parameters:
  docGuid: string (required)
  add: array (optional) - Marks to add: ["bold", "italic", "underline", "strike"]
  remove: array (optional) - Marks to remove
  link: object | null (optional) - { href: "url" } to add, null to remove

returns:
  success: boolean
  formattedText: string
  formattedLength: number
```

#### `insert_block`

Insert a new block element.

```yaml
name: insert_block
description: |
  Insert a new block (paragraph, heading, list item, etc.)
  Position is relative to current cursor block.

parameters:
  docGuid: string (required)
  position: "before" | "after" (required) - Relative to current block
  type: "paragraph" | "heading" | "bulletList" | "orderedList" | "codeBlock" (required)
  attributes: object (optional) - e.g., { level: 2 } for headings
  content: string (optional) - Initial text content

returns:
  success: boolean
  newBlockIndex: number
  cursor: object - Cursor moves to new block
```

#### `set_block_type`

Change the type of the current block.

```yaml
name: set_block_type
description: |
  Convert the current block to a different type without changing its content.
  Cursor must be in a block. Like using format menu to change paragraph to heading.

parameters:
  docGuid: string (required)
  type: "paragraph" | "heading" | "bulletList" | "orderedList" | "codeBlock" (required)
  attributes: object (optional) - e.g., { level: 2 } for headings, { language: "javascript" } for code

returns:
  success: boolean
  previousType: string
  newType: string
  cursor: object - Cursor stays in same logical position
```

---

### 3.5 Undo/Redo

#### `undo`

```yaml
name: undo
description: Undo the last operation made by this agent.

parameters:
  docGuid: string (required)

returns:
  success: boolean
  undone: boolean - false if nothing to undo
  cursor: object - Restored cursor position
```

#### `redo`

```yaml
name: redo
description: Redo a previously undone operation.

parameters:
  docGuid: string (required)

returns:
  success: boolean
  redone: boolean - false if nothing to redo
  cursor: object - Restored cursor position
```

---

### 3.6 Context & Reading

#### `read_context`

Read text around cursor without moving.

```yaml
name: read_context
description: |
  Get text content around the current cursor position.
  Useful for understanding context before making edits.

parameters:
  docGuid: string (required)
  before: number (optional, default: 200) - Characters before cursor
  after: number (optional, default: 200) - Characters after cursor
  includeBlockInfo: boolean (optional, default: true)

returns:
  context:
    before: string
    after: string
    selection: string | null - Selected text if any
  blocks: array (if includeBlockInfo) - Blocks in the context range:
    - index: number
      type: string
      preview: string (first 50 chars)
  cursor:
    block: number
    offset: number
    blockType: string
```

#### `read_document`

Read entire document or specific blocks.

```yaml
name: read_document
description: |
  Read document content. Can read all or specific block range.
  Does not move cursor.

parameters:
  docGuid: string (required)
  fromBlock: number (optional) - Start block (default: 0)
  toBlock: number (optional) - End block inclusive (default: last)
  format: "text" | "structured" (optional, default: "structured")

returns:
  content: string | array - Plain text or structured blocks
  blockCount: number
  characterCount: number
```

#### `get_collaborators`

See who else is in the document.

```yaml
name: get_collaborators
description: |
  Get information about other users currently in the document,
  including their cursor positions and what they're working on.
  Useful for coordination and avoiding edit conflicts.

parameters:
  docGuid: string (required)

returns:
  collaborators: array
    - userId: string
      name: string
      color: string
      isAgent: boolean
      cursor: object | null
        block: number
        offset: number
        blockType: string
        hasSelection: boolean
        selectionPreview: string (first 50 chars if selection exists)
  totalCount: number
```

---

## 4. Streaming Implementation

For the `streaming: true` option on `insert`:

```
Agent calls: insert({ text: "Hello, world!", streaming: true })

Timeline visible to users:
  t=0ms:   "H" appears, cursor at position 1
  t=50ms:  "He" appears, cursor at position 2
  t=100ms: "Hel" appears, cursor at position 3
  ...
  t=650ms: "Hello, world!" complete, cursor at position 13

Tool returns after streaming completes.
```

**Implementation approach:**
- Insert characters in small batches (configurable delay, e.g., 30-50ms per char)
- Update awareness cursor position with each batch
- All changes are still atomic from Yjs perspective (in a single logical operation for undo purposes)
- Can be interrupted/undone with `undo`

---

## 5. Error Handling

| Error Code | Cause | Recovery |
|------------|-------|----------|
| `SESSION_NOT_FOUND` | No active session for document | Call `open_document` first |
| `SESSION_EXPIRED` | Timeout occurred | Call `open_document` to re-establish |
| `NO_SELECTION` | Operation requires selection | Use `select` or `find` with action="select" |
| `POSITION_OUT_OF_BOUNDS` | Tried to move past document boundary | Check return value `moved` count |
| `PERMISSION_DENIED` | Viewer role tried to edit | N/A - user needs editor access |

---

## 6. Example Workflows

### Workflow A: Find and Replace

```
1. open_document(docGuid: "abc")
   → Cursor at start, 15 blocks

2. find(query: "teh", action: "select")
   → Found at block 3, selected "teh"

3. insert(text: "the")
   → Replaced selection, cursor after "the"

4. find(query: "teh", action: "select")
   → Found at block 7, selected "teh"

5. insert(text: "the")
   → Replaced again

6. find(query: "teh", action: "peek")
   → Not found, done!
```

### Workflow B: Add Content to End of Document

```
1. open_document(docGuid: "abc", position: "end")
   → Cursor at end

2. insert_block(position: "after", type: "heading", attributes: { level: 2 })
   → New heading block added, cursor inside it

3. insert(text: "Conclusion", streaming: true)
   → Text appears with typing effect

4. insert_block(position: "after", type: "paragraph")
   → New paragraph after heading

5. insert(text: "In summary, ...", streaming: true)
   → Paragraph content typed out
```

### Workflow C: Format Existing Text

```
1. open_document(docGuid: "abc")

2. find(query: "important", action: "select")
   → Found and selected "important"

3. format(add: ["bold", "underline"])
   → Text now bold and underlined

4. select(mode: "none")
   → Selection collapsed, cursor after "important"
```

### Workflow D: Edit with Undo

```
1. open_document(docGuid: "abc")

2. find(query: "Hello", action: "select")
   → Selected "Hello"

3. insert(text: "Goodbye")
   → Replaced "Hello" with "Goodbye"

4. undo()
   → "Hello" restored, cursor back to original position

5. redo()
   → "Goodbye" reapplied
```

---

## 7. Comparison: Current API vs Cursor-Based API

### Current API (Error-Prone)

```
1. get_document_structure → 15 blocks
2. read_document_blocks(fromIndex: 3) → "The quick fox jumps"
3. insert_text(elementIndex: 3, characterPosition: 10, text: "brown ")
   → ERROR: position stale (someone else edited!)
4. get_document_structure again...
5. read_document_blocks(fromIndex: 3) → "The very quick fox jumps"
6. Recalculate: "quick" is now at position 14
7. insert_text(elementIndex: 3, characterPosition: 14, text: "brown ")
```

### Cursor-Based API (Robust)

```
1. open_document(docGuid: "abc")
2. find(query: "quick", action: "goto")
   → Cursor moves before "quick"
3. move(direction: "forward", unit: "word", count: 1)
   → Cursor now after "quick "
4. insert(text: "brown ")
   → Works regardless of concurrent edits!
```

---

## 8. Design Decisions

### 8.1 Block Operations

**Decision**: Keep `insert_block` as a separate tool; `insert` handles text naturally.

| Operation | Tool | Behavior |
|-----------|------|----------|
| Add text | `insert` | Inserts text at cursor |
| Press "Enter" | `insert(text: "\n")` | Creates new paragraph (like human pressing Enter) |
| Create heading/list/code | `insert_block` | Explicit block type creation |
| Change existing block type | `set_block_type` | Convert block without changing content |

**Rationale**: This is clearest for agents because:
- Explicit intent: "make a heading" vs "insert text with newline"
- No magic syntax to memorize
- Matches human mental model (typing vs. using format menu/shortcuts)

### 8.2 Multi-Block Selection Behavior

**Decision**: Behave identically to human editors.

When a selection spans multiple blocks and `delete` is called:
- All selected content is deleted
- If selection partially covers blocks at boundaries, remaining content is merged into one block
- If entire blocks are selected, they are removed completely
- Cursor ends up at the deletion point (where selection started)

Example:
```
Before (selection marked with |...|):
  [0] paragraph: "Hello |world"
  [1] paragraph: "This is content"
  [2] paragraph: "More| text here"

After delete:
  [0] paragraph: "Hello text here"
                       ^ cursor here
```

### 8.3 Read vs Navigate

**Decision**: Reading tools never move the cursor.

- `read_document` and `read_context` are read-only operations
- Matches human behavior: scrolling/reading doesn't relocate cursor
- Navigation is always explicit via `goto`, `move`, `find`
- Keeps reading and navigation as separate concerns

### 8.4 Concurrent Awareness

**Decision**: Agents can see other users' cursor positions via a dedicated tool.

New tool `get_collaborators` provides visibility into who else is editing:

```yaml
name: get_collaborators
description: |
  Get information about other users currently in the document,
  including their cursor positions and what they're working on.

parameters:
  docGuid: string (required)

returns:
  collaborators: array
    - userId: string
      name: string
      color: string
      isAgent: boolean
      cursor: object | null
        block: number
        offset: number
        blockType: string
        hasSelection: boolean
        selectionPreview: string (first 50 chars if selection exists)
  totalCount: number
```

This enables agents to:
- See who else is in the document
- Avoid editing the same area as another user
- Coordinate with other agents
- Understand the collaborative context

---

## 9. Implementation Notes

### Yjs Integration

The cursor-based API leverages existing Yjs primitives:

- **RelativePosition**: Used for cursor/anchor storage - survives concurrent edits
- **Awareness**: Used for cursor visibility to other users
- **UndoManager**: Used for undo/redo functionality
- **Transactions**: All edits wrapped in transactions for atomicity

### Session Storage

Agent sessions stored in memory (similar to current `agent-presence.js`):

```javascript
{
  docGuid: string,
  userId: string,
  provider: WebsocketProvider,
  awareness: Awareness,
  cursor: {
    anchor: YjsRelativePosition,
    head: YjsRelativePosition,
  },
  undoManager: Y.UndoManager,
  timeoutId: NodeJS.Timeout,
  createdAt: number,
}
```

### Migration Path

The cursor-based API can coexist with the current API during transition:
- New tools use `v2_` prefix or separate namespace
- Existing tools continue to work
- Gradual migration as agents adopt new API
