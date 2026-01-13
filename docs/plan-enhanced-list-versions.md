# Plan: Enhanced list_document_versions Tool

## Overview

Enhance the existing `list_document_versions` tool with three powerful new capabilities:
1. **Nested subversions** - Optionally include drill-down into individual edit groups
2. **Rich metadata** - Document size, edit counts, deltas, and duration for each version
3. **Time-based filtering** - Filter versions by time range with natural language support

This enhances 1 existing tool without changing the tool count (remains at 21).

## Current State

The existing tool provides:
- Paginated list of versions
- Basic version info (id, name, clock range, timestamp, authors)
- Auto-generated and named versions

## New Capabilities

### 1. Nested Subversions

Optionally include a `subversions` array within each version showing the individual edit groups (10-second threshold).

**Why nested instead of separate tool?**
- Single API call gets full hierarchy
- Natural hierarchical structure
- Subversions already use "clock-{N}" format compatible with `read_document_version`
- Backward compatible (only included when requested)

### 2. Rich Metadata

Add metadata fields extracted during existing Y.Doc reconstruction:
- `editCount` - Number of meaningful edits (text changes)
- `duration` - Time span of editing session in milliseconds
- `characterCount` - Total characters at this version
- `wordCount` - Total words at this version
- `blockCount` - Total blocks (paragraphs, headings, lists)
- `charactersDelta` - Characters added/removed since previous version

**Performance:** Minimal overhead since we're already building Y.Docs during `filterMeaningfulUpdates()`.

### 3. Time-Based Filtering

Add `since` and `until` parameters to filter versions by time range.

**Supported formats:**
- **Relative times:** "1 hour ago", "2 days ago", "yesterday", "last week", "last monday"
- **Absolute times:** ISO 8601 dates and datetimes ("2024-01-15", "2024-01-15T10:30:00Z")

**Timezone handling:** See dedicated section below.

## Tool Specification

**Tool Name:** `list_document_versions` (existing tool, enhanced)

**Parameters:**
```typescript
{
  docGuid: string;              // Document UUID (required)
  limit?: number;               // Max versions to return, 1-100 (default: 50)
  offset?: number;              // Skip N versions for pagination (default: 0)
  includeSubversions?: boolean; // Include nested subversions (default: false)

  // Time-based filtering (optional, in server's timezone unless ISO 8601 with explicit timezone)
  since?: string;               // Filter versions since this time
  until?: string;               // Filter versions until this time

  // Relative time examples: "1 hour ago", "yesterday", "last week", "last monday"
  // Absolute time examples: "2024-01-15", "2024-01-15T10:30:00Z", "2024-01-15T10:30:00-05:00"
}
```

**Returns:**
```typescript
{
  versions: Array<{
    id: string;              // Version ID (UUID or "auto-{clock}")
    name: string | null;     // Version name (null for auto)
    clockStart: number;
    clockEnd: number;
    timestamp: string;       // ISO 8601 timestamp (UTC)
    formattedTimestamp: string; // Human-readable
    authors: Array<{
      id: string;
      name: string;
      email: string;
      picture: string;
      color: string;
      isAgent: boolean;
    }>;
    isNamed: boolean;
    isCurrent: boolean;

    // NEW: Metadata
    editCount: number;        // Number of meaningful edits (text changes)
    duration: number;         // Time span in milliseconds
    characterCount: number;   // Total characters at this version
    wordCount: number;        // Total words at this version
    blockCount: number;       // Total blocks (paragraphs, headings, etc.)
    charactersDelta: number;  // Characters added/removed vs previous version

    // NEW: Only present if includeSubversions: true
    subversions?: Array<{
      id: string;             // "clock-{clockEnd}" - use with read_document_version
      clockStart: number;
      clockEnd: number;
      previousClock: number;  // Baseline clock for diffing
      timestamp: string;      // ISO 8601 timestamp (UTC)
      formattedTimestamp: string;
      authors: Array<{...}>;  // Same format as version authors

      // Metadata (same fields as version)
      editCount: number;
      duration: number;
      characterCount: number;
      wordCount: number;
      blockCount: number;
      charactersDelta: number;
    }>;
  }>;
  totalEdits: number;
  pagination: {
    total: number;            // Total versions (after time filtering)
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}
```

## Timezone Handling

### Current Behavior

- All timestamps in the database are stored in **UTC**
- The `timestamp` field returned is ISO 8601 in **UTC** (e.g., "2024-01-15T10:30:00.000Z")
- `formattedTimestamp` is human-readable but timezone-agnostic (e.g., "January 15, 10:30 AM")

### New Behavior for Time Filtering

**Server Timezone as Default:**
- Relative times ("yesterday", "1 hour ago") are interpreted in the **server's timezone**
- Absolute times without timezone ("2024-01-15") are interpreted in the **server's timezone**
- Absolute times with explicit timezone ("2024-01-15T10:30:00Z" or "2024-01-15T10:30:00-05:00") use that timezone

**Why server timezone?**
- Consistent and predictable behavior
- No need for agents to specify timezone
- Server timezone is typically UTC in production
- Can be documented clearly

**Implementation:**
```javascript
function parseTimeFilter(timeStr) {
  // Try parsing as ISO 8601 first (handles explicit timezones)
  const isoDate = new Date(timeStr);
  if (!isNaN(isoDate.getTime())) {
    return isoDate.getTime();
  }

  // Parse relative time expressions (in server timezone)
  const now = Date.now();
  const lowered = timeStr.toLowerCase().trim();

  // "X hours/days/weeks/months ago"
  const agoMatch = lowered.match(/^(\d+)\s+(hour|day|week|month)s?\s+ago$/);
  if (agoMatch) {
    const amount = parseInt(agoMatch[1]);
    const unit = agoMatch[2];
    const ms = {
      hour: 3600000,
      day: 86400000,
      week: 604800000,
      month: 2592000000
    }[unit];
    return now - (amount * ms);
  }

  // "yesterday", "last week", "last month"
  const relativeTimes = {
    'yesterday': now - 86400000,
    'last week': now - 604800000,
    'last month': now - 2592000000,
  };

  // "last monday", "last tuesday", etc.
  const dayMatch = lowered.match(/^last\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (dayMatch) {
    const targetDay = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      .indexOf(dayMatch[1]);
    const today = new Date();
    const currentDay = today.getDay();
    const daysBack = currentDay >= targetDay ? currentDay - targetDay : 7 - (targetDay - currentDay);
    const lastDay = new Date(today);
    lastDay.setDate(today.getDate() - daysBack);
    lastDay.setHours(0, 0, 0, 0);
    return lastDay.getTime();
  }

  if (lowered in relativeTimes) {
    return relativeTimes[lowered];
  }

  throw new Error(`Invalid time format: "${timeStr}". Use ISO 8601 or relative time like "yesterday", "1 hour ago"`);
}
```

**Documentation:**
The tool description must clearly state:
```
Time filtering uses the server's timezone unless you provide an ISO 8601 timestamp
with explicit timezone (e.g., "2024-01-15T10:30:00Z" for UTC or "2024-01-15T10:30:00-05:00" for EST).

Examples:
- "yesterday" - 24 hours ago in server timezone
- "2024-01-15" - Midnight on Jan 15 in server timezone
- "2024-01-15T10:30:00Z" - 10:30 AM UTC (explicit timezone)
- "2024-01-15T10:30:00-05:00" - 10:30 AM EST (explicit timezone)
```

## Error Cases

| Scenario | Error Message |
|----------|---------------|
| Document not found | `Document not found or you do not have access` |
| Invalid time format | `Invalid time format: "{value}". Use ISO 8601 or relative time like "yesterday", "1 hour ago"` |
| since > until | `'since' time must be before 'until' time` |
| Invalid limit/offset | Handled by schema validation |

## Implementation

### Backend Changes

**File:** `server/mcp/tools/list-document-versions.js`

**Enhanced Handler:**
```javascript
async function handler(args, agentToken) {
  const { docGuid, limit = 50, offset = 0, includeSubversions = false, since, until } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Validate and clamp limit
  const effectiveLimit = Math.min(Math.max(1, limit), 100);

  // Check document access (any role - read-only)
  const accessResult = await pool.query(
    `SELECT d.id, ds.role
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  // Get full version timeline (now returns metadata)
  const timeline = await versionHistory.getVersionTimeline(persistenceProvider, docGuid);

  // Apply time-based filtering if provided
  let filteredVersions = timeline.versions;
  if (since || until) {
    const sinceTime = since ? parseTimeFilter(since) : null;
    const untilTime = until ? parseTimeFilter(until) : null;

    if (sinceTime && untilTime && sinceTime > untilTime) {
      throw new Error("'since' time must be before 'until' time");
    }

    filteredVersions = timeline.versions.filter(v => {
      const versionTime = new Date(v.timestamp).getTime();
      if (sinceTime && versionTime < sinceTime) return false;
      if (untilTime && versionTime > untilTime) return false;
      return true;
    });
  }

  // Apply pagination
  const total = filteredVersions.length;
  const paginatedVersions = filteredVersions.slice(offset, offset + effectiveLimit);
  const hasMore = offset + effectiveLimit < total;

  // If includeSubversions, fetch subversions for each paginated version
  if (includeSubversions) {
    for (const version of paginatedVersions) {
      const subversions = await versionHistory.getUpdatesForVersion(
        persistenceProvider,
        docGuid,
        version.clockStart,
        version.clockEnd
      );
      version.subversions = subversions; // Already includes metadata
    }
  }

  return {
    versions: paginatedVersions,
    totalEdits: timeline.totalEdits,
    pagination: {
      total,
      limit: effectiveLimit,
      offset,
      hasMore,
    },
  };
}
```

**File:** `server/version-history.js`

**Enhance metadata extraction in existing functions:**

```javascript
// In filterMeaningfulUpdates() - already reconstructs Y.Docs
// Add metadata extraction while building docs:

function extractMetadata(doc, previousDoc) {
  const text = extractTextFromDoc(doc);
  const previousText = previousDoc ? extractTextFromDoc(previousDoc) : '';

  const characterCount = text.length;
  const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;
  const blockCount = doc.get('default', Y.XmlFragment).length;
  const charactersDelta = characterCount - previousText.length;

  return {
    characterCount,
    wordCount,
    blockCount,
    charactersDelta
  };
}

// Include in version/subversion objects returned by:
// - getVersionTimeline()
// - getUpdatesForVersion()
```

### Input Schema Changes

```javascript
const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 50,
      description: 'Maximum number of versions to return (1-100)',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      default: 0,
      description: 'Number of versions to skip for pagination',
    },
    includeSubversions: {
      type: 'boolean',
      default: false,
      description: 'Include nested subversions array in each version',
    },
    since: {
      type: 'string',
      description: 'Filter versions since this time (ISO 8601 or relative like "yesterday")',
    },
    until: {
      type: 'string',
      description: 'Filter versions until this time (ISO 8601 or relative)',
    },
  },
  required: ['docGuid'],
};
```

## Performance Considerations

**Time Filtering:**
- O(n) where n = number of versions
- Very fast (just timestamp comparisons)
- Applied before pagination

**Metadata Extraction:**
- Piggybacks on existing Y.Doc reconstruction in `filterMeaningfulUpdates()`
- Character/word/block counting is O(m) where m = document size
- Only computed for versions being returned (respects pagination)
- Minimal overhead

**Subversions:**
- Only fetched when `includeSubversions: true`
- Only fetched for paginated versions (not all versions)
- Uses existing `getUpdatesForVersion()` function

## Backward Compatibility

- All new parameters are **optional**
- Default behavior unchanged (`includeSubversions: false`, no time filtering)
- Existing tool calls continue to work exactly as before
- Metadata added to existing response (non-breaking addition)

## Testing

### Unit Tests

**Backward compatibility:**
- ✅ Default behavior unchanged (includeSubversions: false)
- ✅ Existing calls work without new parameters

**includeSubversions parameter:**
- ✅ `false` (default) → no subversions field present
- ✅ `true` → subversions nested in each version
- ✅ Subversions only fetched for paginated versions (not all)
- ✅ Single edit → 1 sub-version
- ✅ Multiple edits <10s apart → grouped into 1 sub-version
- ✅ Multiple edits >10s apart → multiple sub-versions
- ✅ Sub-versions have correct previousClock for diffing
- ✅ Sub-versions sorted most recent first

**Metadata fields:**
- ✅ editCount, duration, characterCount, wordCount, blockCount, charactersDelta present
- ✅ Metadata extraction piggybacks on existing Y.Doc reconstruction
- ✅ charactersDelta correctly shows positive/negative changes
- ✅ Metadata present for both versions and subversions

**Time filtering:**
- ✅ Relative time parsing: "yesterday", "X hours ago", "last monday"
- ✅ Absolute time parsing: ISO 8601 dates and datetimes
- ✅ Timezone handling: server timezone for dates, explicit for ISO 8601 with TZ
- ✅ `since` only filters correctly
- ✅ `until` only filters correctly
- ✅ Both `since` and `until` filter range correctly
- ✅ Time range validation: `since` must be before `until`
- ✅ Invalid time format → error with helpful message

**Error cases:**
- ✅ Document not found
- ✅ Invalid time format
- ✅ since > until

### Integration Tests

- List versions without new parameters → unchanged behavior
- List versions with includeSubversions: true → subversions nested in each version
- Create document with multiple editing sessions → verify subversion grouping
- Read content at specific sub-version using "clock-{N}" format
- Verify subversions work for both auto and named versions
- Verify previousClock values enable proper diffing
- Pagination + subversions → only paginated versions include subversions
- Time filtering + pagination → correct results
- Metadata extraction → values match expected document state

### Manual Testing

**Hierarchical version listing:**
- "Show me the version history with all individual edits"
- "List versions and show me the edits in the most recent one"
- "What changed in the second edit of the last version?"
- "How many times did Bob edit during version 'Draft 1'?"
- "Show me all edits made between 2pm and 3pm"

**Metadata queries:**
- "How much did the document grow during the last version?"
- "Which version had the most edits?"
- "Show me versions where the document was under 1000 words"
- "Find the biggest change in the document"

**Time-based filtering:**
- "Show me versions from yesterday" (should use "yesterday" - no timezone needed)
- "What changed in the last 2 hours?" (should use "2 hours ago" - no timezone needed)
- "List all changes from last week" (should use "last week" - no timezone needed)
- "Show me what was edited last Monday" (should use "last monday" - no timezone needed)
- "What happened between January 1 and January 15?" (should use dates - no timezone needed for date-only)
- "Any edits in the past hour?" (should use "1 hour ago" - no timezone needed)

**Time-based filtering with user timezone:**
- "Show me versions from 2pm yesterday" → Agent should ask "What timezone are you in?" then convert
- "List changes between 9am and 5pm on January 15" → Agent should ask for timezone then convert
- "Show me edits made at 3:30pm" → Agent should ask for timezone then convert
- Agent should convert timezone-specific requests to ISO 8601 with explicit timezone offset

## Documentation Updates

### Tool Description

Update the description in `server/mcp/tools/list-document-versions.js`:

```
═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- limit: Maximum versions to return, 1-100 (optional, default: 50)
- offset: Number of versions to skip for pagination (optional, default: 0)
- includeSubversions: Include nested subversions array (optional, default: false)
- since: Filter versions since this time (optional)
- until: Filter versions until this time (optional)

Time filtering uses the server's timezone unless you provide an ISO 8601 timestamp
with explicit timezone.

IMPORTANT FOR AGENTS: When a user provides a time reference, you should:
1. Ask the user for their timezone if they provide a specific time (e.g., "2pm yesterday")
2. Convert their local time to ISO 8601 with explicit timezone
3. Use that timezone-aware timestamp in the since/until parameters

Example conversation:
  User: "Show me versions from 2pm yesterday"
  Agent: "What timezone are you in?"
  User: "EST" or "America/New_York"
  Agent: Converts to "2024-01-15T14:00:00-05:00" and uses that

For vague references like "yesterday" or "last week", you can use the relative
format and the server timezone is acceptable.

Supported time formats:
- Relative: "yesterday", "1 hour ago", "2 days ago", "last week", "last monday"
  (interpreted in server timezone - acceptable for vague references)
- Absolute: "2024-01-15" (server TZ - use only if user doesn't specify time)
- Absolute with timezone: "2024-01-15T10:30:00Z" (UTC), "2024-01-15T10:30:00-05:00" (EST)
  (PREFERRED when user provides specific times)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- versions: Array of version objects with:
  - [existing fields...]
  - editCount: Number of meaningful edits (text changes)
  - duration: Time span in milliseconds
  - characterCount: Total characters at this version
  - wordCount: Total words at this version
  - blockCount: Total blocks (paragraphs, headings, lists)
  - charactersDelta: Characters added/removed vs previous version
  - subversions: (if includeSubversions: true) Array of edit groups with same metadata

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// List versions (default, backward compatible)
await list_document_versions({ docGuid: "abc-123" });

// List versions with nested subversions
await list_document_versions({
  docGuid: "abc-123",
  includeSubversions: true
});

// List versions from yesterday
await list_document_versions({
  docGuid: "abc-123",
  since: "yesterday"
});

// List versions from the last 2 hours
await list_document_versions({
  docGuid: "abc-123",
  since: "2 hours ago"
});

// List versions between two dates
await list_document_versions({
  docGuid: "abc-123",
  since: "2024-01-01",
  until: "2024-01-15"
});

// List versions from last Monday with subversions
await list_document_versions({
  docGuid: "abc-123",
  since: "last monday",
  includeSubversions: true
});

// User-specific time with timezone (PREFERRED for specific times)
// User says: "Show me versions from 2pm yesterday"
// Agent asks: "What timezone are you in?"
// User says: "EST" or "America/New_York"
// Agent converts to:
await list_document_versions({
  docGuid: "abc-123",
  since: "2024-01-15T14:00:00-05:00"  // Explicit timezone
});
```

### README.md
- No tool count change
- Update version history section with new capabilities
- Add examples showing enhanced features

### docs/mcp-integration-summary.md
- No tool count change
- Update `list_document_versions` description to mention:
  - `includeSubversions` parameter for nested drill-down
  - `since`/`until` parameters for time filtering
  - Rich metadata fields
- Add comprehensive examples

## Implementation Checklist

- [ ] Modify `server/mcp/tools/list-document-versions.js`:
  - [ ] Add new parameters to input schema
  - [ ] Implement time parsing function `parseTimeFilter()`
  - [ ] Add time filtering logic to handler
  - [ ] Add conditional subversion fetching
  - [ ] Update tool description
- [ ] Modify `server/version-history.js`:
  - [ ] Add metadata extraction in `filterMeaningfulUpdates()`
  - [ ] Add metadata extraction in `getUpdatesForVersion()`
  - [ ] Include metadata in returned version/subversion objects
- [ ] Write unit tests for:
  - [ ] Time parsing function (all formats)
  - [ ] Time filtering logic
  - [ ] includeSubversions parameter
  - [ ] Metadata extraction
  - [ ] Backward compatibility
  - [ ] Edge cases
- [ ] Add integration tests
- [ ] Update README.md
- [ ] Update docs/mcp-integration-summary.md

## Examples

```javascript
// Basic usage (unchanged, backward compatible)
const result = await list_document_versions({
  docGuid: "abc-123"
});

// With nested subversions
const withSubs = await list_document_versions({
  docGuid: "abc-123",
  includeSubversions: true
});

// Response with metadata and subversions:
{
  versions: [
    {
      id: "auto-42",
      name: null,
      clockStart: 35,
      clockEnd: 42,
      timestamp: "2024-01-15T10:35:30.000Z",
      formattedTimestamp: "January 15, 10:35 AM",
      authors: [...],
      isNamed: false,
      isCurrent: true,

      // NEW: Metadata
      editCount: 3,
      duration: 45000,        // 45 seconds
      characterCount: 1250,
      wordCount: 185,
      blockCount: 8,
      charactersDelta: 150,   // +150 chars since previous version

      // NEW: Subversions (when includeSubversions: true)
      subversions: [
        {
          id: "clock-42",
          clockStart: 40,
          clockEnd: 42,
          previousClock: 39,
          timestamp: "2024-01-15T10:35:30.000Z",
          formattedTimestamp: "January 15, 10:35 AM",
          authors: [...],
          editCount: 1,
          duration: 8000,
          characterCount: 1250,
          wordCount: 185,
          blockCount: 8,
          charactersDelta: 45
        },
        // ... more subversions
      ]
    },
    // ... more versions
  ],
  totalEdits: 100,
  pagination: { total: 10, limit: 50, offset: 0, hasMore: false }
}

// Time filtering
const recent = await list_document_versions({
  docGuid: "abc-123",
  since: "2 hours ago"
});

const dateRange = await list_document_versions({
  docGuid: "abc-123",
  since: "2024-01-01",
  until: "2024-01-15"
});

// Combined
const everything = await list_document_versions({
  docGuid: "abc-123",
  since: "last monday",
  includeSubversions: true,
  limit: 10
});
```

## Estimated Time

**~3.5 hours** including implementation, tests, documentation, and metadata extraction

## Security Considerations

- Read-only operation (all roles can access)
- Document access verified via `document_shares` table
- Time filtering doesn't expose sensitive information
- Metadata extracted from already-accessible document content
- Parameterized queries prevent SQL injection
