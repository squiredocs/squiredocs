/**
 * Tests for concurrent-edit awareness helpers.
 */
const {
  getObservedClocks,
  foreignEditsSince,
  buildStalenessNote,
} = require('../chat-staleness');

function call(toolCallId, toolName, input) {
  return { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input }] };
}
function result(toolCallId, value) {
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId, output: { type: 'json', value } }] };
}

const AGENT = { userId: 'u1', agentName: 'Squire Docs Assistant' };

describe('getObservedClocks', () => {
  it('takes the max clock per doc across read and modify results', () => {
    const messages = [
      call('c1', 'read_document', { docGuid: 'A' }),
      result('c1', { content: [], clock: 5 }),
      call('c2', 'modify', { docGuid: 'A', script: 'x' }),
      result('c2', { changed: true, clock: 9 }),
      call('c3', 'read_document', { docGuid: 'B' }),
      result('c3', { content: [], clock: 2 }),
    ];

    const observed = getObservedClocks(messages);

    expect(observed.get('A')).toBe(9);
    expect(observed.get('B')).toBe(2);
  });

  it('keeps the highest clock even if a later read reports a lower one', () => {
    const messages = [
      call('c1', 'read_document', { docGuid: 'A' }),
      result('c1', { content: [], clock: 12 }),
      call('c2', 'read_document', { docGuid: 'A' }),
      result('c2', { content: [], clock: 7 }),
    ];
    expect(getObservedClocks(messages).get('A')).toBe(12);
  });

  it('ignores results without a numeric clock', () => {
    const messages = [
      call('c1', 'read_document', { docGuid: 'A' }),
      result('c1', { content: [] }),
    ];
    expect(getObservedClocks(messages).has('A')).toBe(false);
  });
});

describe('foreignEditsSince', () => {
  const updates = [
    { clock: 5, userId: 'u1', agentName: 'Squire Docs Assistant', userName: 'Sam' },
    { clock: 6, userId: 'u2', agentName: null, userName: 'Alice' },
    { clock: 7, userId: 'u1', agentName: null, userName: 'Sam' },
  ];

  it('reports other users who edited after the baseline', () => {
    const editors = foreignEditsSince(updates, 5, AGENT);
    const names = editors.map(e => e.name);
    expect(names).toContain('Alice'); // clock 6, other user
    expect(names).toContain('Sam');   // clock 7, the human typing directly
  });

  it('excludes the agent\'s own edits', () => {
    // Only the agent edited after clock 4 (clock 5 is the agent).
    const editors = foreignEditsSince(
      [{ clock: 5, userId: 'u1', agentName: 'Squire Docs Assistant', userName: 'Sam' }],
      4,
      AGENT,
    );
    expect(editors).toEqual([]);
  });

  it('excludes edits at or before the baseline', () => {
    const editors = foreignEditsSince(updates, 7, AGENT);
    expect(editors).toEqual([]);
  });

  it('deduplicates repeated editors', () => {
    const repeated = [
      { clock: 6, userId: 'u2', agentName: null, userName: 'Alice' },
      { clock: 8, userId: 'u2', agentName: null, userName: 'Alice' },
    ];
    expect(foreignEditsSince(repeated, 5, AGENT)).toHaveLength(1);
  });
});

describe('buildStalenessNote', () => {
  it('returns null when nothing is stale', () => {
    expect(buildStalenessNote([])).toBeNull();
    expect(buildStalenessNote(null)).toBeNull();
  });

  it('lists each stale doc with its editors, using title when present', () => {
    const note = buildStalenessNote([
      { docGuid: 'A', title: 'Plan', editors: [{ name: 'Alice' }] },
      { docGuid: 'B', title: null, editors: [{ name: 'Bob' }, { name: 'Sam' }] },
    ]);
    expect(note).toContain('"Plan" was edited by Alice');
    expect(note).toContain('B was edited by Bob, Sam');
    expect(note).toContain('Re-read it');
  });
});
