/**
 * Tests for XPath query highlighting via agent presence
 */
const Y = require('yjs');
const agentPresence = require('../mcp/agent-presence');
const { executeScript, executeSandboxed, wrapForTracking, OperationTracker } = require('../mcp/sandbox');

// Spy on agent-presence functions
let mockQueueHighlightSequence;

describe('XPath query highlighting', () => {
  let doc;
  let fragment;
  let mockSession;

  beforeEach(() => {
    // Set up spies
    mockQueueHighlightSequence = jest.spyOn(agentPresence, 'queueHighlightSequence').mockImplementation(() => true);

    doc = new Y.Doc();
    fragment = doc.get('test', Y.XmlFragment);

    // Create mock session for executeScript
    const undoManager = new Y.UndoManager(fragment);
    mockSession = {
      sessionId: 'test-session',
      provider: { doc },
      undoManager,
    };

    // Set up test document with multiple headings
    const h1 = new Y.XmlElement('heading');
    h1.setAttribute('level', 1);
    const h1Text = new Y.XmlText();
    h1Text.insert(0, 'Main Title');
    h1.insert(0, [h1Text]);

    const h2a = new Y.XmlElement('heading');
    h2a.setAttribute('level', 2);
    const h2aText = new Y.XmlText();
    h2aText.insert(0, 'Section One');
    h2a.insert(0, [h2aText]);

    const h2b = new Y.XmlElement('heading');
    h2b.setAttribute('level', 2);
    const h2bText = new Y.XmlText();
    h2bText.insert(0, 'Section Two');
    h2b.insert(0, [h2bText]);

    const para = new Y.XmlElement('paragraph');
    const paraText = new Y.XmlText();
    paraText.insert(0, 'Some content');
    para.insert(0, [paraText]);

    fragment.insert(0, [h1, h2a, h2b, para]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should queue highlights for xpath() results', async () => {
    const script = `
      export default function edit(doc) {
        // Find all level-2 headings
        const headings = xpath('//heading[@level=2]');
        // Just accessing them should trigger highlights
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);

    // Should have called queueHighlightSequence with positions for 2 headings
    expect(mockQueueHighlightSequence).toHaveBeenCalledTimes(1);
    const [sessionId, positions] = mockQueueHighlightSequence.mock.calls[0];
    expect(sessionId).toBe('test-session');
    expect(positions.length).toBe(2);
  });

  it('should queue highlight for xpathFirst() result', async () => {
    const script = `
      export default function edit(doc) {
        const heading = xpathFirst('//heading[@level=1]');
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);

    // Should have called queueHighlightSequence with single position
    expect(mockQueueHighlightSequence).toHaveBeenCalledTimes(1);
    const [sessionId, positions] = mockQueueHighlightSequence.mock.calls[0];
    expect(sessionId).toBe('test-session');
    expect(positions.length).toBe(1);
  });

  it('should not queue highlights when xpath returns no results', async () => {
    const script = `
      export default function edit(doc) {
        const results = xpath('//nonexistent');
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);

    // Should not have called queueHighlightSequence since no results
    expect(mockQueueHighlightSequence).not.toHaveBeenCalled();
  });

  it('should queue highlights for mutations', async () => {
    const script = `
      export default function edit(doc) {
        // First query triggers highlights
        const headings = xpath('//heading');
        // Then mutation should also queue a highlight
        headings[0].setAttribute('modified', true);
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);

    // Should have queued highlights for XPath query and mutations via queueHighlightSequence
    // (mutations are batched through MutationAggregator and flushed via queueHighlightSequence)
    expect(mockQueueHighlightSequence).toHaveBeenCalled();
  });

  it('should handle multiple xpath queries', async () => {
    const script = `
      export default function edit(doc) {
        const h1s = xpath('//heading[@level=1]');
        const h2s = xpath('//heading[@level=2]');
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);

    // Should have called queueHighlightSequence twice (once per query)
    expect(mockQueueHighlightSequence).toHaveBeenCalledTimes(2);
  });
});
