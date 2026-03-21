/**
 * Tests for XPath query highlighting via agent presence
 */
const Y = require('yjs');
const agentPresence = require('../mcp/agent-presence');
const { executeScript } = require('../mcp/sandbox');

// Mock agent-presence to capture highlight calls
jest.mock('../mcp/agent-presence', () => ({
  queueHighlightSequence: jest.fn(),
  clearHighlightQueue: jest.fn(() => 0),
}));

describe('XPath query highlighting', () => {
  let doc;
  let fragment;
  let mockSession;

  beforeEach(() => {
    jest.clearAllMocks();

    doc = new Y.Doc();
    fragment = doc.get('default', Y.XmlFragment);

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

    // Highlights flow: isolate → worker → bridge → agentPresence.queueHighlightSequence
    expect(agentPresence.queueHighlightSequence).toHaveBeenCalled();
  });

  it('should queue highlight for xpathFirst() result', async () => {
    const script = `
      export default function edit(doc) {
        const heading = xpathFirst('//heading[@level=1]');
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);

    // Should have queued highlights
    expect(agentPresence.queueHighlightSequence).toHaveBeenCalled();
  });

  it('should not queue highlights when xpath returns no results', async () => {
    const script = `
      export default function edit(doc) {
        const results = xpath('//nonexistent');
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);

    // No xpath highlights should be queued (mutations may still trigger highlights)
    // Check that no highlight call has positions for xpath results
    const highlightCalls = agentPresence.queueHighlightSequence.mock.calls;
    // Filter for calls that come from xpath (not mutation aggregator)
    // Mutation aggregator calls have a different signature
    const xpathHighlightCalls = highlightCalls.filter(call =>
      call[0] === 'test-session' && Array.isArray(call[1]) && call[1].length > 0
        && call[1][0].anchor && call[1][0].head
    );
    // No xpath results means no xpath highlight calls
    expect(xpathHighlightCalls.length).toBe(0);
  });

  it('should queue highlights for mutations', async () => {
    const script = `
      export default function edit(doc) {
        // Query and modify triggers highlights
        const headings = xpath('//heading');
        headings[0].setAttribute('modified', true);
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);

    // Should have queued highlights for XPath query and mutations
    expect(agentPresence.queueHighlightSequence).toHaveBeenCalled();
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

    // Should have called queueHighlightSequence at least twice (once per query)
    expect(agentPresence.queueHighlightSequence).toHaveBeenCalledTimes(2);
  });
});
