/**
 * Integration test for document editing workflow (Mock version)
 *
 * Tests the workflow without requiring actual database/WebSocket connections.
 * This helps identify logic issues in the tool implementations.
 */

const Y = require('yjs');

describe('Document Editing Workflow - Mock Test', () => {
  let goto, insert, insertBlock, move, deleteTool, format, select;
  let mockPersistence, mockSession, mockYdoc, mockXmlFragment;
  let mockAgentPresence;

  const testDocGuid = 'test-doc-guid';
  const testUserId = 'test-user-id';
  const mockAgentToken = {
    userId: testUserId,
    agentName: 'Test Agent',
    rawToken: 'mock-token',
  };

  beforeAll(() => {
    // Set up Yjs document with initial content
    mockYdoc = new Y.Doc();
    mockXmlFragment = mockYdoc.get('default', Y.XmlFragment);

    // Create initial content: "Come join me in the playground!"
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Come join me in the playground!');
    paragraph.insert(0, [text]);
    mockXmlFragment.insert(0, [paragraph]);

    // Mock persistence
    mockPersistence = {
      getPool: jest.fn(() => ({
        query: jest.fn().mockResolvedValue({
          rows: [{ id: testDocGuid, role: 'editor' }],
        }),
      })),
    };

    // Mock session
    const sessionId = 'test-session-id';
    mockSession = {
      sessionId,
      docGuid: testDocGuid,
      userId: testUserId,
      key: `${testUserId}-${testDocGuid}`,
      provider: {
        doc: mockYdoc,
        awareness: {
          setLocalStateField: jest.fn(),
        },
      },
      cursor: null,
      undoManager: new Y.UndoManager(mockXmlFragment, { captureTimeout: 500 }),
      lastActivityAt: Date.now(),
      cleanup: jest.fn(),
    };

    // Initialize cursor at start
    const firstTextNode = mockXmlFragment.toArray()[0].toArray()[0];
    const relPos = Y.createRelativePositionFromTypeIndex(firstTextNode, 0);
    const posJson = Y.relativePositionToJSON(relPos);
    mockSession.cursor = {
      anchor: posJson,
      head: posJson,
    };

    // Mock agent presence
    const activeSessions = new Map([[sessionId, mockSession]]);
    mockAgentPresence = {
      getActiveSessions: jest.fn(() => activeSessions),
      getOrCreateSession: jest.fn(async () => mockSession),
      updateSessionCursor: jest.fn((sid, anchor, head) => {
        const session = activeSessions.get(sid);
        if (session) {
          session.cursor = { anchor, head };
        }
      }),
    };

    // Load tools and inject mocks
    goto = require('../../tools/goto');
    insert = require('../../tools/insert');
    insertBlock = require('../../tools/insert-block');
    move = require('../../tools/move');
    deleteTool = require('../../tools/delete');
    format = require('../../tools/format');
    select = require('../../tools/select');

    // Initialize tools with mock persistence
    goto.init(mockPersistence);
    insert.init(mockPersistence);
    insertBlock.init(mockPersistence);
    move.init(mockPersistence);
    deleteTool.init(mockPersistence);
    format.init(mockPersistence);
    select.init(mockPersistence);

    // Mock agentPresence module
    jest.mock('../../agent-presence', () => mockAgentPresence);
  });

  test('1. goto document_end should calculate correct position', async () => {
    try {
      const result = await goto.handler(
        {
          docGuid: testDocGuid,
          target: { type: 'document_end' },
        },
        mockAgentToken
      );

      console.log('goto result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.cursor).toBeDefined();
      expect(result.cursor.block).toBe(0);
      expect(result.cursor.offset).toBe(31); // End of "Come join me in the playground!"
    } catch (error) {
      console.error('goto error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });

  test('2. insert text should add content', async () => {
    try {
      const textToInsert = '\n\nHere are some fun activities:';

      const result = await insert.handler(
        {
          docGuid: testDocGuid,
          text: textToInsert,
        },
        mockAgentToken
      );

      console.log('insert result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.insertedLength).toBe(textToInsert.length);

      // Verify text was actually inserted
      const blocks = mockXmlFragment.toArray();
      const firstBlock = blocks[0];
      const textNode = firstBlock.toArray()[0];
      const content = textNode.toString();

      console.log('Document content after insert:', content);
      expect(content).toContain('Come join me in the playground!');
      expect(content).toContain('Here are some fun activities');
    } catch (error) {
      console.error('insert error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });

  test('3. insert_block should create new block', async () => {
    try {
      const result = await insertBlock.handler(
        {
          docGuid: testDocGuid,
          position: 'after',
          type: 'paragraph',  // Changed from blockType to type, simplified to paragraph
          content: 'Here is a new paragraph',
        },
        mockAgentToken
      );

      console.log('insert_block result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      // Verify block was created
      const blocks = mockXmlFragment.toArray();
      console.log('Number of blocks after insert_block:', blocks.length);
      expect(blocks.length).toBe(2); // Should now have 2 blocks

      // Check if new paragraph was created
      const lastBlock = blocks[blocks.length - 1];
      expect(lastBlock.nodeName).toBe('paragraph');
    } catch (error) {
      console.error('insert_block error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });

  test('4. move cursor should update position', async () => {
    try {
      const result = await move.handler(
        {
          docGuid: testDocGuid,
          direction: 'forward',
          unit: 'char',
          count: 5,
          extend: false,
        },
        mockAgentToken
      );

      console.log('move result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.cursor).toBeDefined();
      expect(result.moved).toBeDefined();
      expect(result.moved).toBeLessThanOrEqual(5);
    } catch (error) {
      console.error('move error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });

  test('5. select word should create selection', async () => {
    try {
      const result = await select.handler(
        {
          docGuid: testDocGuid,
          mode: 'word',
        },
        mockAgentToken
      );

      console.log('select result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.selection).toBeDefined();
      expect(result.selection.text).toBeDefined();
      expect(result.selection.text.length).toBeGreaterThan(0);
    } catch (error) {
      console.error('select error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });

  test('6. format should actually apply marks to text (regression test)', async () => {
    try {
      // First, select some text
      const selectResult = await select.handler(
        {
          docGuid: testDocGuid,
          mode: 'word',
        },
        mockAgentToken
      );

      expect(selectResult.success).toBe(true);
      expect(selectResult.selection).toBeDefined();
      const selectedText = selectResult.selection.text;

      // Apply bold formatting
      const formatResult = await format.handler(
        {
          docGuid: testDocGuid,
          add: ['bold'],
        },
        mockAgentToken
      );

      console.log('format result:', JSON.stringify(formatResult, null, 2));

      expect(formatResult).toBeDefined();
      expect(formatResult.success).toBe(true);

      // CRITICAL: Verify that the formatting was actually applied in the Yjs document
      // This checks the actual document structure, not just the return value
      const blocks = mockXmlFragment.toArray();
      let foundFormattedText = false;

      // Search through all blocks and text nodes to find the formatted text
      for (const block of blocks) {
        if (block instanceof Y.XmlElement) {
          const children = block.toArray();
          for (const child of children) {
            if (child instanceof Y.XmlText) {
              const delta = child.toDelta();
              // Check if any delta segment has bold formatting and matches our selected text
              for (const op of delta) {
                if (op.attributes && op.attributes.bold && op.insert.includes(selectedText)) {
                  foundFormattedText = true;
                  console.log('✓ Found formatted text in delta:', op);
                  break;
                }
              }
            }
          }
        }
        if (foundFormattedText) break;
      }

      expect(foundFormattedText).toBe(true);
      console.log('✓ Format test passed - bold marks were actually applied to the document');
    } catch (error) {
      console.error('format error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });

  test('7. find + select + format with complex document structure (headings + lists)', async () => {
    try {
      // Load the find tool
      const find = require('../../tools/find');
      find.init(mockPersistence);

      // Create a document that matches the user's bug report structure:
      // headings, paragraphs, then a list
      mockYdoc.transact(() => {
        mockXmlFragment.delete(0, mockXmlFragment.length);

        // Heading 1
        const h1 = new Y.XmlElement('heading');
        h1.setAttribute('level', 1);
        const h1Text = new Y.XmlText();
        h1Text.insert(0, 'Free Researcher Access Pitch');
        h1.insert(0, [h1Text]);
        mockXmlFragment.insert(0, [h1]);

        // Heading 2
        const h2 = new Y.XmlElement('heading');
        h2.setAttribute('level', 2);
        const h2Text = new Y.XmlText();
        h2Text.insert(0, 'Core Concept');
        h2.insert(0, [h2Text]);
        mockXmlFragment.insert(1, [h2]);

        // Paragraph
        const p1 = new Y.XmlElement('paragraph');
        const p1Text = new Y.XmlText();
        p1Text.insert(0, 'Position early users as research partners.');
        p1.insert(0, [p1Text]);
        mockXmlFragment.insert(2, [p1]);

        // Another heading
        const h3 = new Y.XmlElement('heading');
        h3.setAttribute('level', 2);
        const h3Text = new Y.XmlText();
        h3Text.insert(0, 'Email Version');
        h3.insert(0, [h3Text]);
        mockXmlFragment.insert(3, [h3]);

        // Paragraph: "What you'd get:"
        const p2 = new Y.XmlElement('paragraph');
        const p2Text = new Y.XmlText();
        p2Text.insert(0, "What you'd get:");
        p2.insert(0, [p2Text]);
        mockXmlFragment.insert(4, [p2]);

        // Bullet list
        const bulletList = new Y.XmlElement('bulletList');

        const items = [
          'Free access to the platform',
          'Early access to API features',
          'Direct input on data formats',
        ];

        for (const itemText of items) {
          const listItem = new Y.XmlElement('listItem');
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, itemText);
          paragraph.insert(0, [text]);
          listItem.insert(0, [paragraph]);
          bulletList.insert(bulletList.length, [listItem]);
        }

        mockXmlFragment.insert(5, [bulletList]);
      });

      // Reset cursor to start of document
      const firstBlock = mockXmlFragment.get(0);
      const firstTextNode = firstBlock.get(0);
      const startPos = Y.createRelativePositionFromTypeIndex(firstTextNode, 0);
      const startPosJson = Y.relativePositionToJSON(startPos);
      mockSession.cursor = { anchor: startPosJson, head: startPosJson };

      console.log('\n=== Document structure ===');
      const blocks = mockXmlFragment.toArray();
      blocks.forEach((block, i) => {
        console.log(`Block ${i}: ${block.nodeName}`);
      });

      // Find and select "What you'd get:" in the paragraph BEFORE the list
      const findResult = await find.handler(
        {
          docGuid: testDocGuid,
          query: "What you'd get:",
          options: { action: 'select' },
        },
        mockAgentToken
      );

      expect(findResult.found).toBe(true);
      expect(findResult.selection.text).toBe("What you'd get:");

      // Apply bold formatting to the selection
      const formatResult = await format.handler(
        {
          docGuid: testDocGuid,
          add: ['bold'],
        },
        mockAgentToken
      );

      expect(formatResult.success).toBe(true);

      console.log('\n=== Checking where bold was applied ===');

      // Check ALL blocks to see where bold was actually applied
      const allBlocks = mockXmlFragment.toArray();
      const boldLocations = [];

      function checkForBold(element, path = []) {
        if (element instanceof Y.XmlText) {
          const delta = element.toDelta();
          delta.forEach(op => {
            if (op.attributes && op.attributes.bold) {
              boldLocations.push({
                path: path.join(' > '),
                text: op.insert,
              });
            }
          });
        } else if (element instanceof Y.XmlElement) {
          for (let i = 0; i < element.length; i++) {
            const child = element.get(i);
            checkForBold(child, [...path, `${element.nodeName}[${i}]`]);
          }
        }
      }

      allBlocks.forEach((block, i) => {
        checkForBold(block, [`block[${i}]:${block.nodeName}`]);
      });

      console.log('Bold applied to:', JSON.stringify(boldLocations, null, 2));

      // Verify that "What you'd get:" is bold in block 4 (the paragraph), not in the list
      const p2Block = mockXmlFragment.get(4); // "What you'd get:" paragraph
      const p2TextNode = p2Block.get(0);
      const p2Delta = p2TextNode.toDelta();

      console.log('Block 4 (What you\'d get:) delta:', JSON.stringify(p2Delta, null, 2));

      // Check if the entire text is bold
      const hasCorrectBold = p2Delta.some(
        op => op.attributes && op.attributes.bold && op.insert === "What you'd get:"
      );

      if (!hasCorrectBold) {
        console.error('ERROR: Bold was not applied to the correct location!');
        console.error('Expected: "What you\'d get:" to be bold in block 4');
        console.error('Actual bold locations:', boldLocations);
      }

      expect(hasCorrectBold).toBe(true);

      console.log('✓ Find + select + format test passed - formatting applied to correct location');
    } catch (error) {
      console.error('find + select + format error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });

  test('8. FULL document test - reproduce exact bug from user report', async () => {
    try {
      const find = require('../../tools/find');
      find.init(mockPersistence);

      // Create the EXACT document structure from the user's bug report
      mockYdoc.transact(() => {
        mockXmlFragment.delete(0, mockXmlFragment.length);

        const blocks = [];

        // Block 0: Heading 1
        const h1 = new Y.XmlElement('heading');
        h1.setAttribute('level', 1);
        const h1Text = new Y.XmlText();
        h1Text.insert(0, 'Free Researcher Access Pitch');
        h1.insert(0, [h1Text]);
        blocks.push(h1);

        // Block 1: Heading 2
        const h2_1 = new Y.XmlElement('heading');
        h2_1.setAttribute('level', 2);
        const h2_1Text = new Y.XmlText();
        h2_1Text.insert(0, 'Core Concept');
        h2_1.insert(0, [h2_1Text]);
        blocks.push(h2_1);

        // Block 2: Long paragraph
        const p1 = new Y.XmlElement('paragraph');
        const p1Text = new Y.XmlText();
        p1Text.insert(
          0,
          'Position early users as "research partners" who help you understand the energy trading/operations space in exchange for free access and influence over product direction.'
        );
        p1.insert(0, [p1Text]);
        blocks.push(p1);

        // Block 3: Heading 2
        const h2_2 = new Y.XmlElement('heading');
        h2_2.setAttribute('level', 2);
        const h2_2Text = new Y.XmlText();
        h2_2Text.insert(0, 'Email Version (Cold Outreach)');
        h2_2.insert(0, [h2_2Text]);
        blocks.push(h2_2);

        // Block 4: Empty paragraph
        const pEmpty = new Y.XmlElement('paragraph');
        blocks.push(pEmpty);

        // Block 5: Subject paragraph
        const pSubject = new Y.XmlElement('paragraph');
        const pSubjectText = new Y.XmlText();
        pSubjectText.insert(
          0,
          'Subject: Research partnership: Real-time earthquake monitoring for energy trading'
        );
        pSubject.insert(0, [pSubjectText]);
        blocks.push(pSubject);

        // Block 6: Hi [Name] paragraph
        const pHi = new Y.XmlElement('paragraph');
        const pHiText = new Y.XmlText();
        pHiText.insert(0, 'Hi [Name],');
        pHi.insert(0, [pHiText]);
        blocks.push(pHi);

        // Block 7: Long paragraph about Sam
        const pSam = new Y.XmlElement('paragraph');
        const pSamText = new Y.XmlText();
        pSamText.insert(
          0,
          "I'm Sam, and I run EarthquakeTrack.com—a seismic monitoring service that traders at ExxonMobil use to track production disruptions in the Permian Basin."
        );
        pSam.insert(0, [pSamText]);
        blocks.push(pSam);

        // Block 8: Long paragraph about API
        const pAPI = new Y.XmlElement('paragraph');
        const pAPIText = new Y.XmlText();
        pAPIText.insert(
          0,
          "I'm currently developing API and data export features specifically for energy trading use cases, and I'm looking for 5-7 research partners to help me understand how these tools fit into actual trading workflows."
        );
        pAPI.insert(0, [pAPIText]);
        blocks.push(pAPI);

        // Block 9: THE TARGET - "What you'd get:"
        const pTarget = new Y.XmlElement('paragraph');
        const pTargetText = new Y.XmlText();
        pTargetText.insert(0, "What you'd get:");
        pTarget.insert(0, [pTargetText]);
        blocks.push(pTarget);

        // Block 10: Bullet list
        const bulletList = new Y.XmlElement('bulletList');
        const items = [
          'Free access to the platform (normally $X/month when it launches)',
          'Early access to API/export features as we build them',
          'Direct input on what data formats and delivery methods actually work for your use case',
          'First look at historical datasets we\'re compiling',
        ];

        for (const itemText of items) {
          const listItem = new Y.XmlElement('listItem');
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, itemText);
          paragraph.insert(0, [text]);
          listItem.insert(0, [paragraph]);
          bulletList.insert(bulletList.length, [listItem]);
        }
        blocks.push(bulletList);

        // Insert all blocks
        for (let i = 0; i < blocks.length; i++) {
          mockXmlFragment.insert(i, [blocks[i]]);
        }
      });

      // Reset cursor to start
      const firstBlock = mockXmlFragment.get(0);
      const firstTextNode = firstBlock.get(0);
      const startPos = Y.createRelativePositionFromTypeIndex(firstTextNode, 0);
      const startPosJson = Y.relativePositionToJSON(startPos);
      mockSession.cursor = { anchor: startPosJson, head: startPosJson };

      console.log('\n=== FULL DOCUMENT TEST ===');
      console.log('Total blocks:', mockXmlFragment.length);

      // Calculate total text length before target
      const { getElementTextLength } = require('../../yjs/text-operations');
      let totalTextBefore = 0;
      for (let i = 0; i < 9; i++) {
        // Blocks 0-8 come before "What you'd get:"
        const block = mockXmlFragment.get(i);
        const blockLen = getElementTextLength(block);
        console.log(`Block ${i} (${block.nodeName}): ${blockLen} chars`);
        totalTextBefore += blockLen;
      }
      console.log(`Total text before target: ${totalTextBefore} chars`);
      console.log(`Target text "What you'd get:" should be at positions ${totalTextBefore}-${totalTextBefore + 15}`);

      // Find and select "What you'd get:"
      const findResult = await find.handler(
        {
          docGuid: testDocGuid,
          query: "What you'd get:",
          options: { action: 'select' },
        },
        mockAgentToken
      );

      expect(findResult.found).toBe(true);
      expect(findResult.selection.text).toBe("What you'd get:");

      // Apply bold
      const formatResult = await format.handler(
        {
          docGuid: testDocGuid,
          add: ['bold'],
        },
        mockAgentToken
      );

      expect(formatResult.success).toBe(true);

      console.log('\n=== Checking where bold was applied ===');

      // Check where bold was actually applied
      const boldLocations = [];
      function checkForBold(element, blockIndex, path = []) {
        if (element instanceof Y.XmlText) {
          const delta = element.toDelta();
          delta.forEach(op => {
            if (op.attributes && op.attributes.bold) {
              boldLocations.push({
                blockIndex,
                path: path.join(' > '),
                text: op.insert,
              });
            }
          });
        } else if (element instanceof Y.XmlElement) {
          for (let i = 0; i < element.length; i++) {
            const child = element.get(i);
            checkForBold(child, blockIndex, [...path, `${element.nodeName}[${i}]`]);
          }
        }
      }

      const allBlocks = mockXmlFragment.toArray();
      allBlocks.forEach((block, i) => {
        checkForBold(block, i, [`block[${i}]:${block.nodeName}`]);
      });

      console.log('Bold locations:', JSON.stringify(boldLocations, null, 2));

      // Verify bold was applied to block 9, not to the list or other blocks
      const targetBlock = mockXmlFragment.get(9);
      const targetText = targetBlock.get(0);
      const targetDelta = targetText.toDelta();

      console.log('Target block delta:', JSON.stringify(targetDelta, null, 2));

      const hasFullBold = targetDelta.some(
        op => op.attributes && op.attributes.bold && op.insert === "What you'd get:"
      );

      if (!hasFullBold) {
        console.error('ERROR: Bold was NOT applied correctly!');
        console.error('Expected: Full text "What you\'d get:" in block 9 to be bold');
        console.error('Actual bold locations:', boldLocations);
        console.error('Target block delta:', targetDelta);
        throw new Error('Bold applied to wrong location - bug reproduced!');
      }

      console.log('✓ FULL document test passed');
    } catch (error) {
      console.error('Full document test error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });

  test('9. Simulate piecemeal document construction with insert_block', async () => {
    try {
      const insertBlock = require('../../tools/insert-block');
      const find = require('../../tools/find');
      insertBlock.init(mockPersistence);
      find.init(mockPersistence);

      // Start with empty document
      mockYdoc.transact(() => {
        mockXmlFragment.delete(0, mockXmlFragment.length);

        // Add an initial empty paragraph to have a valid cursor position
        const initialPara = new Y.XmlElement('paragraph');
        const initialText = new Y.XmlText();
        initialPara.insert(0, [initialText]);
        mockXmlFragment.insert(0, [initialPara]);
      });

      // Reset cursor to start of empty paragraph
      const initialBlock = mockXmlFragment.get(0);
      const initialTextNode = initialBlock.get(0);
      const initialPos = Y.createRelativePositionFromTypeIndex(initialTextNode, 0);
      const initialPosJson = Y.relativePositionToJSON(initialPos);
      mockSession.cursor = { anchor: initialPosJson, head: initialPosJson };

      console.log('\n=== SIMULATING PIECEMEAL DOCUMENT CONSTRUCTION ===');

      // Build document block by block (simulating user's workflow)
      // Block 0: Heading 1
      await insertBlock.handler(
        {
          docGuid: testDocGuid,
          type: 'heading',
          attributes: { level: 1 },
          content: 'Free Researcher Access Pitch',
          position: 'after',
        },
        mockAgentToken
      );

      // Block 1: Heading 2
      await insertBlock.handler(
        {
          docGuid: testDocGuid,
          type: 'heading',
          attributes: { level: 2 },
          content: 'Core Concept',
          position: 'after',
        },
        mockAgentToken
      );

      // Block 2: Paragraph
      await insertBlock.handler(
        {
          docGuid: testDocGuid,
          type: 'paragraph',
          content: 'Position early users as research partners.',
          position: 'after',
        },
        mockAgentToken
      );

      // Block 3: Heading
      await insertBlock.handler(
        {
          docGuid: testDocGuid,
          type: 'heading',
          attributes: { level: 2 },
          content: 'Email Version',
          position: 'after',
        },
        mockAgentToken
      );

      // Block 4: Empty paragraph
      await insertBlock.handler(
        {
          docGuid: testDocGuid,
          type: 'paragraph',
          content: '',
          position: 'after',
        },
        mockAgentToken
      );

      // Blocks 5-8: More paragraphs
      await insertBlock.handler(
        {
          docGuid: testDocGuid,
          type: 'paragraph',
          content: 'Subject: Research partnership',
          position: 'after',
        },
        mockAgentToken
      );

      await insertBlock.handler(
        {
          docGuid: testDocGuid,
          type: 'paragraph',
          content: 'Hi [Name],',
          position: 'after',
        },
        mockAgentToken
      );

      await insertBlock.handler(
        {
          docGuid: testDocGuid,
          type: 'paragraph',
          content: "I'm Sam, and I run EarthquakeTrack.com",
          position: 'after',
        },
        mockAgentToken
      );

      await insertBlock.handler(
        {
          docGuid: testDocGuid,
          type: 'paragraph',
          content: "I'm currently developing API features",
          position: 'after',
        },
        mockAgentToken
      );

      // Block 9: THE TARGET - "What you'd get:"
      console.log('\n--- Inserting target block 10 ---');
      await insertBlock.handler(
        {
          docGuid: testDocGuid,
          type: 'paragraph',
          content: "What you'd get:",
          position: 'after',
        },
        mockAgentToken
      );

      // Inspect ALL blocks
      console.log('\n=== INSPECTING ALL BLOCKS AFTER INSERT ===');
      const blocks = mockXmlFragment.toArray();
      console.log(`Total blocks: ${blocks.length}`);

      blocks.forEach((block, i) => {
        const textContent = [];
        function extractText(node) {
          if (node instanceof Y.XmlText) {
            textContent.push(node.toString());
          } else if (node instanceof Y.XmlElement) {
            for (let j = 0; j < node.length; j++) {
              extractText(node.get(j));
            }
          }
        }
        extractText(block);
        console.log(`Block ${i} (${block.nodeName || 'UNDEFINED'}): "${textContent.join('')}"`);
      });

      console.log('\n=== DETAILED INSPECTION OF TARGET BLOCK ===');
      const targetBlockIndex = blocks.length - 1; // Last block should be "What you'd get:"
      if (blocks.length > targetBlockIndex) {
        const targetBlock = blocks[targetBlockIndex];
        console.log(`Target block ${targetBlockIndex} type: ${targetBlock.nodeName}`);
        console.log(`Target block ${targetBlockIndex} children: ${targetBlock.length}`);

        for (let i = 0; i < targetBlock.length; i++) {
          const child = targetBlock.get(i);
          if (child instanceof Y.XmlText) {
            console.log(`  Child ${i}: XmlText, length=${child.length}, content="${child.toString()}"`);
            console.log(`  Delta:`, JSON.stringify(child.toDelta(), null, 2));
          } else if (child instanceof Y.XmlElement) {
            console.log(`  Child ${i}: XmlElement (${child.nodeName}), ${child.length} children`);
          }
        }

        // Calculate text length and positions
        let textLength = 0;
        function countText(node) {
          if (node instanceof Y.XmlText) {
            console.log(`    Counting XmlText: ${node.length} chars - "${node.toString()}"`);
            textLength += node.length;
          } else if (node instanceof Y.XmlElement) {
            console.log(`    Traversing ${node.nodeName} with ${node.length} children`);
            for (let i = 0; i < node.length; i++) {
              countText(node.get(i));
            }
          }
        }
        console.log(`\nCounting text in target block:`);
        countText(targetBlock);
        console.log(`Total text length: ${textLength}`);
      }

      // Now try find + format
      console.log('\n=== FIND + FORMAT TEST ===');

      // Reset cursor to start
      const firstBlock = mockXmlFragment.get(0);
      const firstTextNode = firstBlock.get(0);
      const startPos = Y.createRelativePositionFromTypeIndex(firstTextNode, 0);
      const startPosJson = Y.relativePositionToJSON(startPos);
      mockSession.cursor = { anchor: startPosJson, head: startPosJson };

      const findResult = await find.handler(
        {
          docGuid: testDocGuid,
          query: "What you'd get:",
          options: { action: 'select' },
        },
        mockAgentToken
      );

      console.log('Find result:', JSON.stringify(findResult.match, null, 2));
      console.log(`Match offset: ${findResult.match.offset} (should be 0 if no hidden content)`);

      if (findResult.match.offset !== 0) {
        console.error(`ERROR: Offset is ${findResult.match.offset}, not 0!`);
        console.error('This indicates hidden content in the block');
      }

      const formatResult = await format.handler(
        {
          docGuid: testDocGuid,
          add: ['bold'],
        },
        mockAgentToken
      );

      console.log('\n=== CHECKING RESULT ===');
      const allBlocksAfter = mockXmlFragment.toArray();
      const targetBlockAfter = allBlocksAfter[findResult.match.block];
      console.log(`Checking block ${findResult.match.block} (find said text is here)`);
      const textNode = targetBlockAfter.get(0);
      const delta = textNode.toDelta();
      console.log('Target block delta after format:', JSON.stringify(delta, null, 2));

      // Check if bold was applied correctly
      const hasFullBold = delta.some(
        op => op.attributes && op.attributes.bold && op.insert === "What you'd get:"
      );

      const hasPartialBold = delta.some(
        op => op.attributes && op.attributes.bold && op.insert !== "What you'd get:"
      );

      if (hasPartialBold) {
        console.error('BUG REPRODUCED: Bold applied to partial text only!');
        console.error('Delta:', delta);
        throw new Error('Bug reproduced - bold applied to wrong location');
      }

      expect(hasFullBold).toBe(true);
      console.log('✓ Piecemeal construction test passed');
    } catch (error) {
      console.error('Piecemeal test error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });

  test('10. Multiple format calls (offset bug reproduction)', async () => {
    try {
      const find = require('../../tools/find');
      find.init(mockPersistence);

      // Create a document with bullet lists to test the offset bug
      mockYdoc.transact(() => {
        mockXmlFragment.delete(0, mockXmlFragment.length);

        // Block 0: Simple paragraph
        const p1 = new Y.XmlElement('paragraph');
        const p1Text = new Y.XmlText();
        p1Text.insert(0, 'Introduction text here to create some offset.');
        p1.insert(0, [p1Text]);
        mockXmlFragment.insert(0, [p1]);

        // Block 1: Bullet list with multiple items
        const bulletList = new Y.XmlElement('bulletList');

        const items = [
          'First item with some text',
          'Second item: this is the target',
          'Third item: another target here',
        ];

        for (const itemText of items) {
          const listItem = new Y.XmlElement('listItem');
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, itemText);
          paragraph.insert(0, [text]);
          listItem.insert(0, [paragraph]);
          bulletList.insert(bulletList.length, [listItem]);
        }

        mockXmlFragment.insert(1, [bulletList]);
      });

      // Reset cursor to start
      const firstBlock = mockXmlFragment.get(0);
      const firstTextNode = firstBlock.get(0);
      const startPos = Y.createRelativePositionFromTypeIndex(firstTextNode, 0);
      const startPosJson = Y.relativePositionToJSON(startPos);
      mockSession.cursor = { anchor: startPosJson, head: startPosJson };

      console.log('\n=== MULTIPLE FORMAT CALLS TEST ===');

      const { getElementTextLength } = require('../../yjs/text-operations');
      const blocks = mockXmlFragment.toArray();

      function getBlockLength(block) {
        let len = 0;
        function traverse(node) {
          if (node instanceof Y.XmlText) {
            len += node.length;
          } else if (node instanceof Y.XmlElement) {
            for (let i = 0; i < node.length; i++) {
              traverse(node.get(i));
            }
          }
        }
        traverse(block);
        return len;
      }

      console.log('Block 0 length:', getElementTextLength(blocks[0]));
      console.log('Block 1 (bulletList) length:', getElementTextLength(blocks[1]));

      // FIRST FORMAT CALL: Find and bold "Introduction"
      console.log('\n--- First format call: "Introduction" ---');
      const find1 = await find.handler(
        {
          docGuid: testDocGuid,
          query: 'Introduction',
          options: { action: 'select' },
        },
        mockAgentToken
      );
      expect(find1.found).toBe(true);
      console.log('Find 1:', { text: find1.match.text, block: find1.match.block, offset: find1.match.offset });

      const format1 = await format.handler({ docGuid: testDocGuid, add: ['bold'] }, mockAgentToken);
      expect(format1.success).toBe(true);

      // Check block structure after first format
      console.log('\n--- Block structure after first format ---');
      const blocksAfter1 = mockXmlFragment.toArray();
      console.log('Block 0 structure:', blocksAfter1[0].toArray().map(n => `${n.constructor.name}[${n.length}]`));
      console.log('Block 1 (bulletList) length after format1:', getBlockLength(blocksAfter1[1]), 'chars');

      // SECOND FORMAT CALL: Find and bold "this is the target"
      console.log('\n--- Second format call: "this is the target" ---');
      const find2 = await find.handler(
        {
          docGuid: testDocGuid,
          query: 'this is the target',
          options: { action: 'select' },
        },
        mockAgentToken
      );
      expect(find2.found).toBe(true);
      console.log('Find 2:', { text: find2.match.text, block: find2.match.block, offset: find2.match.offset });

      const format2 = await format.handler({ docGuid: testDocGuid, add: ['bold'] }, mockAgentToken);
      expect(format2.success).toBe(true);

      // Check block structure after second format
      console.log('\n--- Block structure after second format ---');
      const blocksAfter2 = mockXmlFragment.toArray();
      console.log('Block 0 length after format2:', getBlockLength(blocksAfter2[0]), 'chars');
      console.log('Block 1 (bulletList) length after format2:', getBlockLength(blocksAfter2[1]), 'chars');

      // THIRD FORMAT CALL: Find and bold "Third item"
      console.log('\n--- Third format call: "Third item" ---');
      const find3 = await find.handler(
        {
          docGuid: testDocGuid,
          query: 'Third item',
          options: { action: 'select' },
        },
        mockAgentToken
      );
      expect(find3.found).toBe(true);
      console.log('Find 3:', { text: find3.match.text, block: find3.match.block, offset: find3.match.offset });

      const format3 = await format.handler({ docGuid: testDocGuid, add: ['bold'] }, mockAgentToken);
      expect(format3.success).toBe(true);

      console.log('\n=== Checking where bold was applied ===');

      function getAllText(element, path = '') {
        const results = [];
        if (element instanceof Y.XmlText) {
          const delta = element.toDelta();
          delta.forEach(op => {
            results.push({
              path,
              text: op.insert,
              bold: op.attributes && op.attributes.bold ? true : false,
            });
          });
        } else if (element instanceof Y.XmlElement) {
          for (let i = 0; i < element.length; i++) {
            const child = element.get(i);
            results.push(...getAllText(child, `${path}>${element.nodeName}[${i}]`));
          }
        }
        return results;
      }

      // Check entire document
      const allBlocks = mockXmlFragment.toArray();
      console.log('\n--- All bold text in document ---');
      allBlocks.forEach((block, i) => {
        const textItems = getAllText(block, `block[${i}]:${block.nodeName}`);
        textItems.forEach(item => {
          if (item.bold) {
            console.log(`  [BOLD] "${item.text}" at ${item.path}`);
          }
        });
      });

      // Collect all bold text
      const allBoldText = [];
      allBlocks.forEach(block => {
        const textItems = getAllText(block, '');
        textItems.forEach(item => {
          if (item.bold) {
            allBoldText.push(item.text);
          }
        });
      });

      const boldTextJoined = allBoldText.join('');
      console.log('\nAll bold text:', boldTextJoined);

      // Verify all three targets are bold
      const expectedBoldParts = ['Introduction', 'this is the target', 'Third item'];
      expectedBoldParts.forEach(expected => {
        if (!boldTextJoined.includes(expected)) {
          console.error(`ERROR: Expected "${expected}" to be bold, but it's not!`);
          console.error('Actual bold text:', boldTextJoined);
          throw new Error(`Bug reproduced - "${expected}" not bolded correctly`);
        }
      });

      console.log('✓ Multiple format calls test passed');
    } catch (error) {
      console.error('Multiple format calls test error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });
});
