/**
 * Tests for document snapshot deduplication (read_document / modify).
 */
const {
  deduplicateReadResults,
  SUPERSEDED_STUB,
  SUPERSEDED_CONTENT_NOTE,
} = require('../chat-dedup');

// ── Message builders (model-message format from convertToModelMessages) ───────
function call(toolCallId, toolName, input) {
  return { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input }] };
}
function result(toolCallId, toolName, value) {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'json', value } }],
  };
}
const para = (text) => [{ type: 'paragraph', text }];

// Convenience: find the output value for a toolCallId in a message list.
function outputFor(messages, toolCallId) {
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    for (const part of msg.content) {
      if (part.type === 'tool-result' && part.toolCallId === toolCallId) return part.output;
    }
  }
  return undefined;
}

describe('deduplicateReadResults', () => {
  it('stubs an earlier full read when the same doc is read again', () => {
    const messages = [
      call('c1', 'read_document', { docGuid: 'A' }),
      result('c1', 'read_document', { content: para('old'), clock: 1 }),
      call('c2', 'read_document', { docGuid: 'A' }),
      result('c2', 'read_document', { content: para('new'), clock: 2 }),
    ];

    const out = deduplicateReadResults(messages);

    expect(outputFor(out, 'c1')).toEqual(SUPERSEDED_STUB);
    expect(outputFor(out, 'c2').value.content).toEqual(para('new'));
  });

  it('lets a changed modify supersede an earlier full read of the same doc', () => {
    const messages = [
      call('r1', 'read_document', { docGuid: 'A' }),
      result('r1', 'read_document', { content: para('before'), clock: 1 }),
      call('m1', 'modify', { docGuid: 'A', script: 'x' }),
      result('m1', 'modify', { changed: true, operationCount: 2, summary: { insert: 2 }, content: para('after') }),
    ];

    const out = deduplicateReadResults(messages);

    expect(outputFor(out, 'r1')).toEqual(SUPERSEDED_STUB);
    expect(outputFor(out, 'm1').value.content).toEqual(para('after'));
  });

  it('stubs an earlier modify content but keeps its metadata when superseded', () => {
    const messages = [
      call('m1', 'modify', { docGuid: 'A', script: 'x' }),
      result('m1', 'modify', {
        changed: true, operationCount: 3, summary: { insert: 3 }, diff: { a: 1 }, content: para('first'),
      }),
      call('r1', 'read_document', { docGuid: 'A' }),
      result('r1', 'read_document', { content: para('latest') }),
    ];

    const out = deduplicateReadResults(messages);
    const m1 = outputFor(out, 'm1').value;

    expect(m1.content).toBe(SUPERSEDED_CONTENT_NOTE);
    expect(m1.changed).toBe(true);
    expect(m1.operationCount).toBe(3);
    expect(m1.summary).toEqual({ insert: 3 });
    expect(m1.diff).toEqual({ a: 1 });
    expect(outputFor(out, 'r1').value.content).toEqual(para('latest'));
  });

  it('keeps the latest of multiple modifies, stubbing earlier ones', () => {
    const messages = [
      call('m1', 'modify', { docGuid: 'A', script: 'x' }),
      result('m1', 'modify', { changed: true, operationCount: 1, content: para('v1') }),
      call('m2', 'modify', { docGuid: 'A', script: 'y' }),
      result('m2', 'modify', { changed: true, operationCount: 2, content: para('v2') }),
    ];

    const out = deduplicateReadResults(messages);

    expect(outputFor(out, 'm1').value.content).toBe(SUPERSEDED_CONTENT_NOTE);
    expect(outputFor(out, 'm1').value.operationCount).toBe(1);
    expect(outputFor(out, 'm2').value.content).toEqual(para('v2'));
  });

  it('does not let a full modify supersede an xpath-scoped read (separate group)', () => {
    const messages = [
      call('rx', 'read_document', { docGuid: 'A', xpath: '//heading' }),
      result('rx', 'read_document', { content: para('h'), matchCount: 1 }),
      call('m1', 'modify', { docGuid: 'A', script: 'x' }),
      result('m1', 'modify', { changed: true, content: para('after') }),
    ];

    const out = deduplicateReadResults(messages);

    expect(outputFor(out, 'rx').value.content).toEqual(para('h'));
    expect(outputFor(out, 'm1').value.content).toEqual(para('after'));
  });

  it('treats a no-op (changed:false) modify as non-snapshot and leaves it alone', () => {
    const messages = [
      call('r1', 'read_document', { docGuid: 'A' }),
      result('r1', 'read_document', { content: para('only') }),
      call('m1', 'modify', { docGuid: 'A', script: 'x' }),
      result('m1', 'modify', { changed: false, message: 'no changes' }),
    ];

    const out = deduplicateReadResults(messages);

    // r1 is the only content-bearing snapshot, so nothing is superseded.
    expect(out).toBe(messages);
    expect(outputFor(out, 'r1').value.content).toEqual(para('only'));
    expect(outputFor(out, 'm1').value).toEqual({ changed: false, message: 'no changes' });
  });

  it('does not deduplicate across different documents', () => {
    const messages = [
      call('a', 'read_document', { docGuid: 'A' }),
      result('a', 'read_document', { content: para('a') }),
      call('b', 'read_document', { docGuid: 'B' }),
      result('b', 'read_document', { content: para('b') }),
    ];

    const out = deduplicateReadResults(messages);

    expect(outputFor(out, 'a').value.content).toEqual(para('a'));
    expect(outputFor(out, 'b').value.content).toEqual(para('b'));
  });

  it('does not mutate the input messages', () => {
    const messages = [
      call('c1', 'read_document', { docGuid: 'A' }),
      result('c1', 'read_document', { content: para('old') }),
      call('c2', 'read_document', { docGuid: 'A' }),
      result('c2', 'read_document', { content: para('new') }),
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));

    deduplicateReadResults(messages);

    expect(messages).toEqual(snapshot);
  });
});
