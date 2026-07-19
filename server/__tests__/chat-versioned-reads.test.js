/**
 * Versioned reads through the chat layer (feature 019 DR-1, T010).
 *
 * read_document absorbed read_document_version's versionId parameter. A
 * versioned read returns HISTORICAL content, so the chat plumbing must not
 * treat it as a snapshot of current content:
 *
 * - chat-staleness: a read_document call WITH versionId must NOT advance the
 *   observed-clock baseline and must NOT count as the doc's latest snapshot
 *   (both SNAPSHOT_TOOLS consumers guard on !input.versionId);
 * - chat-dedup: read_document WITH versionId is keyed per
 *   (docGuid, versionId, xpath, format) — today's read_document_version rule —
 *   and a versioned read never supersedes a current read or vice versa.
 */
const { getObservedClocks, getRevertedDocs } = require('../api/chat-staleness');
const { buildDedupKey, deduplicateReadResults, SUPERSEDED_STUB } = require('../api/chat-dedup');

const DOC = 'doc-versioned-1';

/** Model-format assistant message with one tool call. */
function assistantCall(toolCallId, toolName, input) {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName, input }],
  };
}

/** Model-format tool message with one result. */
function toolResult(toolCallId, value) {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, output: { type: 'json', value } }],
  };
}

describe('chat-staleness with versionId reads', () => {
  test('a read_document WITHOUT versionId records the observed clock (baseline)', () => {
    const messages = [
      assistantCall('c1', 'read_document', { docGuid: DOC }),
      toolResult('c1', { content: 'x', clock: 41 }),
    ];
    expect(getObservedClocks(messages).get(DOC)).toBe(41);
  });

  test('a read_document WITH versionId does NOT record a staleness snapshot', () => {
    const messages = [
      assistantCall('c1', 'read_document', { docGuid: DOC, versionId: '42' }),
      // Historical results carry no clock field, but even a hostile result
      // with one must not advance the baseline.
      toolResult('c1', { content: 'historical', clock: 999 }),
    ];
    expect(getObservedClocks(messages).has(DOC)).toBe(false);
  });

  test('a versioned read does not overwrite the latest-snapshot slot in getRevertedDocs', () => {
    // The agent's modify was reverted by the user; a later VERSIONED read is
    // historical context, not a re-read of current content — the doc must
    // still report as reverted.
    const messages = [
      {
        parts: [
          { type: 'tool-modify', toolName: 'modify', input: { docGuid: DOC }, reverted: true },
        ],
      },
      {
        parts: [
          { type: 'tool-read_document', toolName: 'read_document', input: { docGuid: DOC, versionId: '7' } },
        ],
      },
    ];
    expect(getRevertedDocs(messages).has(DOC)).toBe(true);
  });

  test('a later CURRENT read clears the reverted flag (behavior unchanged)', () => {
    const messages = [
      {
        parts: [
          { type: 'tool-modify', toolName: 'modify', input: { docGuid: DOC }, reverted: true },
          { type: 'tool-read_document', toolName: 'read_document', input: { docGuid: DOC } },
        ],
      },
    ];
    expect(getRevertedDocs(messages).has(DOC)).toBe(false);
  });
});

describe('chat-dedup with versionId reads', () => {
  test('read_document with versionId keys per (docGuid, versionId, xpath, format)', () => {
    const key = buildDedupKey('read_document', {
      docGuid: DOC, versionId: '42', xpath: '//heading', format: 'markdown',
    });
    expect(key).toContain(DOC);
    expect(key).toContain('42');
    expect(key).toContain('//heading');
    expect(key).toContain('markdown');

    // Distinct versions never collide.
    const other = buildDedupKey('read_document', {
      docGuid: DOC, versionId: '43', xpath: '//heading', format: 'markdown',
    });
    expect(other).not.toBe(key);
  });

  test('a versioned read never shares a group with a current read (either direction)', () => {
    const current = buildDedupKey('read_document', { docGuid: DOC, format: 'structured' });
    const versioned = buildDedupKey('read_document', { docGuid: DOC, versionId: '42', format: 'structured' });
    expect(versioned).not.toBe(current);

    // And a versioned xpath read never collides with a current xpath read.
    const currentX = buildDedupKey('read_document', { docGuid: DOC, xpath: '//p', format: 'structured' });
    const versionedX = buildDedupKey('read_document', { docGuid: DOC, versionId: '42', xpath: '//p', format: 'structured' });
    expect(versionedX).not.toBe(currentX);
  });

  test('versioned read_document keys match the legacy read_document_version grouping', () => {
    // A mid-conversation client switching from the hidden alias to
    // read_document({ versionId }) must land in the SAME dedup group.
    const viaAlias = buildDedupKey('read_document_version', {
      docGuid: DOC, versionId: '42', xpath: '', format: 'structured',
    });
    const viaMerged = buildDedupKey('read_document', {
      docGuid: DOC, versionId: '42', format: 'structured',
    });
    expect(viaMerged).toBe(viaAlias);
  });

  test('deduplicateReadResults: versioned and current reads never supersede each other', () => {
    const messages = [
      assistantCall('c1', 'read_document', { docGuid: DOC, versionId: '42' }),
      toolResult('c1', { content: 'historical' }),
      assistantCall('c2', 'read_document', { docGuid: DOC }),
      toolResult('c2', { content: 'current' }),
    ];
    const out = deduplicateReadResults(messages);
    // Both survive in full — neither is stubbed.
    expect(out[1].content[0].output.value.content).toBe('historical');
    expect(out[3].content[0].output.value.content).toBe('current');
  });

  test('deduplicateReadResults: repeated identical versioned reads keep only the latest', () => {
    const messages = [
      assistantCall('c1', 'read_document', { docGuid: DOC, versionId: '42' }),
      toolResult('c1', { content: 'historical (older result)' }),
      assistantCall('c2', 'read_document', { docGuid: DOC, versionId: '42' }),
      toolResult('c2', { content: 'historical (newer result)' }),
    ];
    const out = deduplicateReadResults(messages);
    expect(out[1].content[0].output).toEqual(SUPERSEDED_STUB);
    expect(out[3].content[0].output.value.content).toBe('historical (newer result)');
  });
});
