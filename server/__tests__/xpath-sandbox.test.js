/**
 * Tests for XPath integration with sandbox execution
 */
const Y = require('yjs');
const { executeScript, executeSandboxed, wrapForTracking, OperationTracker } = require('../mcp/sandbox');

describe('XPath sandbox integration', () => {
  let doc;
  let fragment;
  let mockSession;

  beforeEach(() => {
    doc = new Y.Doc();
    fragment = doc.get('test', Y.XmlFragment);

    // Create mock session for executeScript
    const undoManager = new Y.UndoManager(fragment);
    mockSession = {
      sessionId: 'test-session',
      provider: { doc },
      undoManager,
    };

    // Set up test document
    const h1 = new Y.XmlElement('heading');
    h1.setAttribute('level', 1);
    const h1Text = new Y.XmlText();
    h1Text.insert(0, 'Main Title');
    h1.insert(0, [h1Text]);

    const h2 = new Y.XmlElement('heading');
    h2.setAttribute('level', 2);
    const h2Text = new Y.XmlText();
    h2Text.insert(0, 'Section');
    h2.insert(0, [h2Text]);

    const para = new Y.XmlElement('paragraph');
    const paraText = new Y.XmlText();
    paraText.insert(0, 'TODO: Fix this bug');
    para.insert(0, [paraText]);

    fragment.insert(0, [h1, h2, para]);
  });

  it('should expose xpath() in sandbox', async () => {
    const script = `
      export default function edit(doc) {
        const headings = xpath('//heading');
        if (headings.length !== 2) {
          throw new Error('Expected 2 headings, got ' + headings.length);
        }
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    if (!result.success) {
      console.error('Script error:', result.error);
    }
    expect(result.success).toBe(true);
  });

  it('should expose xpathFirst() in sandbox', async () => {
    const script = `
      export default function edit(doc) {
        const h1 = xpathFirst('//heading[@level=1]');
        if (!h1) {
          throw new Error('Expected to find h1');
        }
        if (h1.getAttribute('level') !== 1) {
          throw new Error('Expected level 1, got ' + h1.getAttribute('level'));
        }
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);
  });

  it('should allow modifying nodes found with xpath', async () => {
    const script = `
      export default function edit(doc) {
        const h2s = xpath('//heading[@level=2]');
        h2s.forEach(h => h.setAttribute('level', 3));
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);

    // Verify the modification
    const h2 = fragment.get(1);
    expect(h2.getAttribute('level')).toBe(3);
  });

  it('should find elements by text content in sandbox', async () => {
    const script = `
      export default function edit(doc) {
        const todos = xpath('//paragraph[contains(., "TODO")]');
        if (todos.length !== 1) {
          throw new Error('Expected 1 TODO paragraph, got ' + todos.length);
        }
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);
  });

  it('should work with following-sibling axis in sandbox', async () => {
    const script = `
      export default function edit(doc) {
        const afterHeading = xpath('//heading[@level=1]/following-sibling::*');
        if (afterHeading.length < 2) {
          throw new Error('Expected at least 2 siblings after h1');
        }
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);
  });

  it('should use document root when no context provided', async () => {
    const script = `
      export default function edit(doc) {
        // xpath() without context should search from document root
        const allHeadings = xpath('//heading');
        if (allHeadings.length !== 2) {
          throw new Error('Expected 2 headings from root');
        }
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);
  });

  it('should track operations on xpath-found nodes', async () => {
    const script = `
      export default function edit(doc) {
        const h1 = xpathFirst('//heading[@level=1]');
        h1.setAttribute('modified', true);
      }
    `;

    const result = await executeScript(script, mockSession, fragment);
    expect(result.success).toBe(true);
    expect(result.operationCount).toBeGreaterThan(0);
  });
});

describe('XPath low-level sandbox execution', () => {
  // Test using executeSandboxed directly for more isolated testing
  let doc;
  let fragment;
  let tracker;

  beforeEach(() => {
    doc = new Y.Doc();
    fragment = doc.get('test', Y.XmlFragment);
    tracker = new OperationTracker();

    // Set up test document
    const h1 = new Y.XmlElement('heading');
    h1.setAttribute('level', 1);
    const h1Text = new Y.XmlText();
    h1Text.insert(0, 'Main Title');
    h1.insert(0, [h1Text]);

    const h2 = new Y.XmlElement('heading');
    h2.setAttribute('level', 2);
    fragment.insert(0, [h1, h2]);
  });

  it('should execute xpath queries with low-level API', () => {
    const wrappedFragment = wrapForTracking(fragment, tracker, []);

    // Use module.exports pattern that executor expects
    const jsCode = `
      module.exports = {
        default: function(doc) {
          var headings = xpath('//heading');
          if (headings.length !== 2) {
            throw new Error('Expected 2 headings');
          }
          headings[0].setAttribute('modified', true);
        }
      };
    `;

    expect(() => {
      executeSandboxed(jsCode, wrappedFragment, tracker, 5000);
    }).not.toThrow();

    // Verify modification
    expect(fragment.get(0).getAttribute('modified')).toBe(true);
  });
});
