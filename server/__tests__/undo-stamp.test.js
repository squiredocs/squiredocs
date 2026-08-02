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
const request = require('supertest');
const express = require('express');
const { setChatPartReverted } = require('../api/chat-revert-stamp');

const CHAT_ID = 'chat-1';
const USER_ID = 'user-1';

/** An in-memory chat store holding one modify card per toolCallId. */
function makeChatStore(cards) {
  const chats = {
    [CHAT_ID]: [{
      role: 'assistant',
      parts: cards.map(c => ({
        type: 'tool-modify',
        toolCallId: c.toolCallId,
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
    const result = toolResult;
    const succeeded = toolName === 'undo' ? result.undone : result.redone;
    if (succeeded && req.body?.chatId && req.body?.toolCallId) {
      try {
        const recordRange = toolName === 'undo' ? result.undoneRecordRange : result.redoneRecordRange;
        await setChatPartReverted(
          { chatStore }, req.body.chatId, USER_ID, req.body.toolCallId, toolName === 'undo',
          { expectedRange: recordRange, label: toolName }
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

  test('an honest-empty undo never stamps anything (no range field, no success)', async () => {
    const store = makeChatStore([{ toolCallId: 'call-a', editRange: { clockStart: 10, clockEnd: 12 } }]);
    const app = makeApp(store, { success: true, undone: false, message: 'Nothing to undo.', clock: 5 });

    await request(app).post('/api/docs/doc-1/undo').send({ chatId: CHAT_ID, toolCallId: 'call-a' });

    expect(store.loadChat).not.toHaveBeenCalled();
    expect(partFor(store, 'call-a').reverted).toBeUndefined();
  });
});
