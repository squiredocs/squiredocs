/**
 * Feature 041 US5 (FR-015, SC-008): the chat "Reverted" stamp is verified
 * against the record actually undone.
 *
 * The card reference on an undo request is client-supplied, while undo picks its
 * target LIFO over the acting identity's records. Those are not always the same
 * edit — the chat assistant is ONE identity shared across all of a user's chats,
 * so a newer edit in another chat wins the LIFO — and a direct POST can name any
 * card at all. Either way, a card ends up claiming "Reverted" about an edit that
 * nobody reverted.
 *
 * The route handler is replicated below from server/index.js (the established
 * endpoint-test pattern in this repo); the verification rule itself is the real
 * shared module.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const { setChatPartReverted } = require('../api/chat-revert-stamp');

const CHAT_ID = 'chat-1';
const USER_ID = 'user-1';
/** The document every request in this suite is made against. */
const DOC_ID = 'doc-1';

/**
 * An in-memory chat store holding one modify card per toolCallId. A card records
 * the document it edited on `input.docGuid`, exactly as the modify tool call
 * does; pass `docGuid: null` for a card that recorded none.
 */
function makeChatStore(cards) {
  const chats = {
    [CHAT_ID]: [{
      role: 'assistant',
      parts: cards.map(c => ({
        type: 'tool-modify',
        toolCallId: c.toolCallId,
        input: (c.docGuid === undefined ? DOC_ID : c.docGuid) === null
          ? {}
          : { docGuid: c.docGuid === undefined ? DOC_ID : c.docGuid },
        output: c.editRange === undefined ? {} : { editRange: c.editRange },
        ...(c.reverted ? { reverted: true } : {}),
      })),
    }],
  };
  return {
    chats,
    loadChat: jest.fn(async (chatId, userId) => (userId === USER_ID ? chats[chatId] : null)),
    saveChat: jest.fn(async (chatId, userId, messages) => { chats[chatId] = messages; }),
  };
}

const partFor = (store, toolCallId) =>
  store.chats[CHAT_ID][0].parts.find(p => p.toolCallId === toolCallId);

/**
 * Mirror of makeUndoRedoHandler's stamp block in server/index.js: the tool
 * result is injected so the test controls which record was undone.
 */
function makeApp(chatStore, toolResult, toolName = 'undo') {
  const app = express();
  app.use(express.json());
  app.post('/api/docs/:docId/undo', async (req, res) => {
    const { docId } = req.params;
    const result = toolResult;
    const succeeded = toolName === 'undo' ? result.undone : result.redone;
    if (succeeded && req.body?.chatId && req.body?.toolCallId) {
      try {
        const recordRange = toolName === 'undo' ? result.undoneRecordRange : result.redoneRecordRange;
        await setChatPartReverted(
          { chatStore }, req.body.chatId, USER_ID, req.body.toolCallId, toolName === 'undo',
          { expectedRange: recordRange, docGuid: docId, label: toolName }
        );
      } catch (e) {
        // best-effort, mirrors the route
      }
    }
    res.json(result);
  });
  return app;
}

describe('041 FR-015: verified "Reverted" stamp', () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  const undoResult = (range) => ({
    success: true,
    undone: true,
    message: 'Edit undone.',
    clock: 42,
    undoneRecordRange: range,
  });

  test('a matching card IS stamped', async () => {
    const store = makeChatStore([{ toolCallId: 'call-a', editRange: { clockStart: 10, clockEnd: 12 } }]);
    const app = makeApp(store, undoResult({ clockStart: 10, clockEnd: 12 }));

    const res = await request(app)
      .post('/api/docs/doc-1/undo')
      .send({ chatId: CHAT_ID, toolCallId: 'call-a' });

    expect(res.status).toBe(200);
    expect(partFor(store, 'call-a').reverted).toBe(true);
    expect(store.saveChat).toHaveBeenCalledTimes(1);
  });

  test('the cross-chat shape: a card whose range is not the undone record is NOT stamped, and the skip is logged', async () => {
    // Card A belongs to chat 1; the LIFO undo target was a newer edit (card B).
    const store = makeChatStore([
      { toolCallId: 'call-a', editRange: { clockStart: 10, clockEnd: 12 } },
      { toolCallId: 'call-b', editRange: { clockStart: 20, clockEnd: 22 } },
    ]);
    const app = makeApp(store, undoResult({ clockStart: 20, clockEnd: 22 }));

    await request(app).post('/api/docs/doc-1/undo').send({ chatId: CHAT_ID, toolCallId: 'call-a' });

    expect(partFor(store, 'call-a').reverted).toBeUndefined();
    expect(partFor(store, 'call-b').reverted).toBeUndefined(); // never stamped by proxy either
    expect(store.saveChat).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('reverted-stamp skipped'))).toBe(true);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('card range 10-12 vs record range 20-22'))).toBe(true);
  });

  test('a card with NO stored edit range is a mismatch by rule: not stamped, logged', async () => {
    const store = makeChatStore([{ toolCallId: 'call-a', editRange: undefined }]);
    const app = makeApp(store, undoResult({ clockStart: 10, clockEnd: 12 }));

    await request(app).post('/api/docs/doc-1/undo').send({ chatId: CHAT_ID, toolCallId: 'call-a' });

    expect(partFor(store, 'call-a').reverted).toBeUndefined();
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('card range none'))).toBe(true);
  });

  test('a direct POST with an arbitrary toolCallId cannot stamp an unrelated card (SC-008)', async () => {
    const store = makeChatStore([
      { toolCallId: 'call-a', editRange: { clockStart: 10, clockEnd: 12 } },
      { toolCallId: 'call-victim', editRange: { clockStart: 1, clockEnd: 2 } },
    ]);
    const app = makeApp(store, undoResult({ clockStart: 10, clockEnd: 12 }));

    const res = await request(app)
      .post('/api/docs/doc-1/undo')
      .send({ chatId: CHAT_ID, toolCallId: 'call-victim' });

    expect(res.status).toBe(200);
    expect(partFor(store, 'call-victim').reverted).toBeUndefined();
    expect(partFor(store, 'call-a').reverted).toBeUndefined();
  });

  test('an unknown toolCallId is skipped and logged, never an error', async () => {
    const store = makeChatStore([{ toolCallId: 'call-a', editRange: { clockStart: 10, clockEnd: 12 } }]);
    const app = makeApp(store, undoResult({ clockStart: 10, clockEnd: 12 }));

    const res = await request(app)
      .post('/api/docs/doc-1/undo')
      .send({ chatId: CHAT_ID, toolCallId: 'nope' });

    expect(res.status).toBe(200);
    expect(store.saveChat).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('no matching tool part'))).toBe(true);
  });

  test('redo is symmetric: it un-stamps only the card whose range matches the redone record', async () => {
    const store = makeChatStore([
      { toolCallId: 'call-a', editRange: { clockStart: 10, clockEnd: 12 }, reverted: true },
      { toolCallId: 'call-b', editRange: { clockStart: 20, clockEnd: 22 }, reverted: true },
    ]);
    const redoResult = {
      success: true,
      redone: true,
      message: 'Edit reapplied.',
      clock: 43,
      redoneRecordRange: { clockStart: 20, clockEnd: 22 },
    };

    // Mismatched card: stays stamped.
    await request(makeApp(store, redoResult, 'redo'))
      .post('/api/docs/doc-1/undo')
      .send({ chatId: CHAT_ID, toolCallId: 'call-a' });
    expect(partFor(store, 'call-a').reverted).toBe(true);

    // Matching card: un-stamped.
    await request(makeApp(store, redoResult, 'redo'))
      .post('/api/docs/doc-1/undo')
      .send({ chatId: CHAT_ID, toolCallId: 'call-b' });
    expect(partFor(store, 'call-b').reverted).toBeUndefined();
  });

  test('the HTTP response body is identical whether the stamp applied or was skipped', async () => {
    const matching = makeChatStore([{ toolCallId: 'call-a', editRange: { clockStart: 10, clockEnd: 12 } }]);
    const mismatched = makeChatStore([{ toolCallId: 'call-a', editRange: { clockStart: 99, clockEnd: 99 } }]);
    const result = undoResult({ clockStart: 10, clockEnd: 12 });

    const a = await request(makeApp(matching, result)).post('/api/docs/doc-1/undo').send({ chatId: CHAT_ID, toolCallId: 'call-a' });
    const b = await request(makeApp(mismatched, result)).post('/api/docs/doc-1/undo').send({ chatId: CHAT_ID, toolCallId: 'call-a' });

    expect(a.body).toEqual(b.body);
    expect(partFor(matching, 'call-a').reverted).toBe(true);
    expect(partFor(mismatched, 'call-a').reverted).toBeUndefined();
  });

  // ── Review M2: the comparison is document-scoped ──────────────────────────
  // Clocks are small per-document integers, so ranges collide freely across
  // documents — every fresh document's first chat edit is around {2,2}. Without
  // a document check, a POST to document A naming a card from document B finds a
  // coinciding range and stamps B's card, whose edit nothing touched.
  describe('review M2: document identity', () => {
    test('a coincident range in ANOTHER document is NOT stamped', async () => {
      // The card belongs to doc-2; the request (and the undone record) is doc-1.
      const store = makeChatStore([
        { toolCallId: 'call-other-doc', docGuid: 'doc-2', editRange: { clockStart: 2, clockEnd: 2 } },
      ]);
      const app = makeApp(store, undoResult({ clockStart: 2, clockEnd: 2 }));

      const res = await request(app)
        .post(`/api/docs/${DOC_ID}/undo`)
        .send({ chatId: CHAT_ID, toolCallId: 'call-other-doc' });

      expect(res.status).toBe(200);
      expect(partFor(store, 'call-other-doc').reverted).toBeUndefined();
      expect(store.saveChat).not.toHaveBeenCalled();
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('card document doc-2 vs undone document doc-1'))).toBe(true);
    });

    test('the SAME document with a matching range is stamped', async () => {
      const store = makeChatStore([
        { toolCallId: 'call-a', docGuid: DOC_ID, editRange: { clockStart: 2, clockEnd: 2 } },
      ]);
      const app = makeApp(store, undoResult({ clockStart: 2, clockEnd: 2 }));

      await request(app).post(`/api/docs/${DOC_ID}/undo`).send({ chatId: CHAT_ID, toolCallId: 'call-a' });

      expect(partFor(store, 'call-a').reverted).toBe(true);
    });

    test('a card with NO recorded document is a mismatch by rule: not stamped, logged', async () => {
      const store = makeChatStore([
        { toolCallId: 'call-a', docGuid: null, editRange: { clockStart: 10, clockEnd: 12 } },
      ]);
      const app = makeApp(store, undoResult({ clockStart: 10, clockEnd: 12 }));

      await request(app).post(`/api/docs/${DOC_ID}/undo`).send({ chatId: CHAT_ID, toolCallId: 'call-a' });

      expect(partFor(store, 'call-a').reverted).toBeUndefined();
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('card document none'))).toBe(true);
    });
  });

  test('an honest-empty undo never stamps anything (no range field, no success)', async () => {
    const store = makeChatStore([{ toolCallId: 'call-a', editRange: { clockStart: 10, clockEnd: 12 } }]);
    const app = makeApp(store, { success: true, undone: false, message: 'Nothing to undo.', clock: 5 });

    await request(app).post('/api/docs/doc-1/undo').send({ chatId: CHAT_ID, toolCallId: 'call-a' });

    expect(store.loadChat).not.toHaveBeenCalled();
    expect(partFor(store, 'call-a').reverted).toBeUndefined();
  });

  // ── PIN: the route block this suite mirrors ───────────────────────────────
  // `makeApp` above is a hand-copy of makeUndoRedoHandler's stamp block, so
  // without a pin the real route could drift out from under a green suite.
  // index.js boots a live server on require; source inspection is the seam.
  describe('PIN: server/index.js makeUndoRedoHandler stamp block', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

    test('the route stamps only on success, with the record range AND the route\'s own docId', () => {
      expect(source).toMatch(
        /const succeeded = toolName === 'undo' \? result\.undone : result\.redone;[\s\S]{0,200}?const recordRange = toolName === 'undo' \? result\.undoneRecordRange : result\.redoneRecordRange;[\s\S]{0,300}?\{ expectedRange: recordRange, docGuid: docId, label \}/
      );
    });
  });
});
