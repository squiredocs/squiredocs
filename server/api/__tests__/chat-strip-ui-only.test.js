/**
 * Feature 039 US5 — UI-only diff data never reaches the model (FR-013, FR-014).
 *
 * Seam (c): replayed conversation history. `stripUiOnlyDiffParts` runs over
 * `modelInputMessages` beside `stripReasoningParts`, BEFORE
 * `convertToModelMessages`.
 *
 * The load-bearing negative requirement here is MC-2 / FR-014: the history
 * conversion must NEVER be handed `{ tools }`. `view_image` and
 * `view_svg_blocks` define `toModelOutput` precisely to ADD image bytes that
 * stored history deliberately omits — passing tools into the conversion would
 * re-inline every image on every turn and can 404 a text-only model. The
 * "obvious simplification" of letting the tool definitions do the stripping is
 * therefore forbidden, and this suite is the guard.
 *
 * Harness modeled on chat.durable-failures.test.js: the REAL POST /api/chat
 * handler runs against a scripted `ai` mock and an in-memory chat store.
 */

jest.mock('../../auth', () => ({
  requireAuth: (req, res, next) => { req.user = { userId: 'u1', email: 'u1@example.com', name: 'U1' }; next(); },
}));
jest.mock('../../rate-limit', () => ({ perUser: () => (req, res, next) => next() }));

const mockStore = new Map();
const mockClone = (v) => JSON.parse(JSON.stringify(v));
jest.mock('../../chat-store', () => ({
  loadChat: jest.fn(async (id) => (mockStore.has(id) ? mockClone(mockStore.get(id)) : [])),
  saveChat: jest.fn(async (id, uid, msgs) => { mockStore.set(id, mockClone(msgs)); }),
}));

jest.mock('../../ai-usage', () => ({
  checkQuota: jest.fn(async () => ({ allowed: true, creditCents: 500, usedCents: 0 })),
  reserveCredits: jest.fn(async () => 'resv-1'),
  reconcileReservation: jest.fn(async () => {}),
  recordUsage: jest.fn(async () => {}),
  computeCostCents: jest.fn(() => 0),
}));
jest.mock('../byok-settings', () => ({ loadByokSettings: jest.fn(async () => null), isByokActive: jest.fn(() => false) }));
jest.mock('../../exception-notifier', () => ({ notifyException: jest.fn() }));
jest.mock('../../email', () => ({ notifyCreditLimitReached: jest.fn() }));
jest.mock('../chat-tools', () => ({ buildTools: jest.fn(() => ({})) }));
jest.mock('../app-settings', () => ({ getSharedDefaultModel: jest.fn(() => 'shared-default') }));
jest.mock('../../mcp/auth/agent-token-factory', () => ({ createAgentTokenPair: jest.fn(() => ({ token: 't' })) }));
jest.mock('../../url', () => ({ buildBaseUrl: jest.fn(() => 'http://test') }));
jest.mock('../../crypto', () => ({ decrypt: jest.fn() }));
jest.mock('../../s3-images', () => ({}));
jest.mock('../../documents', () => ({ getDocument: jest.fn(), hasAccess: jest.fn(async () => false) }));

// A vision-capable shared model, so no image swaps interfere with MS-6.
// NOTE: chat-models is only PARTIALLY mocked here — the strip helpers under
// test are the REAL implementations, which is the point of the suite.
jest.mock('../chat-models', () => {
  const actual = jest.requireActual('../chat-models');
  return {
    ...actual,
    resolveChatModel: jest.fn(() => ({
      model: {},
      def: { key: 'test', modelId: 'm', provider: 'anthropic', supportsImages: true },
      provider: {},
    })),
    buildProviderOptions: jest.fn(() => null),
  };
});
jest.mock('../ai-providers', () => ({
  ...jest.requireActual('../ai-providers'),
  getProviderConfig: jest.fn(() => ({ capabilities: {} })),
}));

const mockConvertToModelMessages = jest.fn((m) => m);
jest.mock('ai', () => ({
  streamText: jest.fn(() => ({
    toUIMessageStream: () => new ReadableStream({
      start(controller) { controller.close(); },
    }),
  })),
  convertToModelMessages: (...args) => mockConvertToModelMessages(...args),
  validateUIMessages: jest.fn(async ({ messages }) => messages),
  createIdGenerator: jest.fn(() => () => 'gen-id'),
  stepCountIs: jest.fn(() => 100),
}));

const request = require('supertest');
const express = require('express');
const chat = require('../chat');

const app = express();
app.use('/api/chat', express.json(), chat.router);

/** A stored assistant turn replaying a past `modify` result carrying a chat diff. */
function storedModifyTurn() {
  return {
    role: 'assistant',
    parts: [
      {
        type: 'tool-modify',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { docGuid: 'doc-1' },
        output: {
          ok: true,
          docGuid: 'doc-1',
          diff: {
            lines: ['-the quick fox', '+the slow fox'],
            hunkStarts: [{ index: 0, oldStart: 1, newStart: 1 }],
            inlineSegments: {
              0: [{ text: 'the ', changed: false }, { text: 'quick', changed: true }],
              1: [{ text: 'the ', changed: false }, { text: 'slow', changed: true }],
            },
          },
        },
      },
    ],
  };
}

/** A stored assistant turn replaying a past `view_image` result. */
function storedImageTurn() {
  return {
    role: 'assistant',
    parts: [
      {
        type: 'tool-view_image',
        toolCallId: 'call-2',
        state: 'output-available',
        input: { docGuid: 'doc-1' },
        // Stored history deliberately carries only the REFERENCE, not the bytes.
        output: { ok: true, images: [{ ref: 'attachment:img-1', mimeType: 'image/png' }] },
      },
    ],
  };
}

const userMsg = { role: 'user', parts: [{ type: 'text', text: 'hi' }] };
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockStore.clear();
  chat.activeStreams.clear();
  jest.clearAllMocks();
  mockConvertToModelMessages.mockImplementation((m) => m);
});

describe('039 US5 seam (c) — replayed history is stripped before model conversion', () => {
  /** Run one turn whose stored history is `history`, return what the conversion saw. */
  async function runTurn(id, history) {
    mockStore.set(id, history);
    await request(app).post('/api/chat').send({ id, message: userMsg });
    await settle();
    expect(mockConvertToModelMessages).toHaveBeenCalled();
    return mockConvertToModelMessages.mock.calls[0];
  }

  // MS-7 — the FR-014 regression guard. This is the most important assertion
  // in the file; see the header note.
  test('MS-7: convertToModelMessages is called with EXACTLY ONE argument', async () => {
    const call = await runTurn('c-args', [userMsg, storedModifyTurn()]);
    expect(call).toHaveLength(1);
    // Belt and braces: nothing tool-shaped smuggled in as a second arg.
    expect(call[1]).toBeUndefined();
  });

  // MS-5
  test('MS-5: replayed tool outputs reach the model without inlineSegments', async () => {
    const [messages] = await runTurn('c-strip', [userMsg, storedModifyTurn()]);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('inlineSegments');
    // The diff itself still reaches the model — only the UI-only field is gone.
    expect(serialized).toContain('the quick fox');
    expect(serialized).toContain('hunkStarts');
  });

  test('MS-5b: the stored history array and its parts are NOT mutated', async () => {
    const history = [userMsg, storedModifyTurn()];
    const snapshot = JSON.stringify(history);
    mockStore.set('c-nomutate', history);
    await request(app).post('/api/chat').send({ id: 'c-nomutate', message: userMsg });
    await settle();
    // MC-5: persisted history + UI keep the segments; only modelInputMessages
    // is rewritten.
    expect(JSON.stringify(history)).toBe(snapshot);
  });

  test('MC-3: no part and no message is ever dropped by the strip', async () => {
    const history = [userMsg, storedModifyTurn(), storedImageTurn()];
    const [messages] = await runTurn('c-count', history);
    // 3 stored + the incoming user message the route appends.
    expect(messages).toHaveLength(4);
    expect(messages[1].parts).toHaveLength(1);
    expect(messages[2].parts).toHaveLength(1);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user']);
  });

  // MS-6 — the other half of the FR-014 guard.
  test('MS-6: an image tool part survives the pass WITHOUT image bytes being re-inlined', async () => {
    const [messages] = await runTurn('c-image', [userMsg, storedImageTurn()]);
    const imagePart = messages[1].parts[0];
    expect(imagePart.type).toBe('tool-view_image');
    // Still the reference form that was stored...
    expect(imagePart.output.images[0].ref).toBe('attachment:img-1');
    // ...and emphatically NOT expanded into base64/binary image data. If
    // `{ tools }` were ever passed to convertToModelMessages, view_image's own
    // toModelOutput would have re-inlined the bytes right here.
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('base64');
    expect(serialized).not.toMatch(/"data"\s*:/);
    expect(imagePart.output.images[0].data).toBeUndefined();
  });

  test('MC-4: the pass runs even for a provider with no capability gates set', async () => {
    // stripProviderExecutedTools / stripReasoningParts are capability-gated;
    // this one is unconditional, because the data is useless to EVERY model.
    const [messages] = await runTurn('c-uncond', [userMsg, storedModifyTurn()]);
    expect(JSON.stringify(messages)).not.toContain('inlineSegments');
  });
});

describe('039 US5 — stripUiOnlyDiffParts unit behavior', () => {
  const { stripUiOnlyDiffParts } = jest.requireActual('../chat-models');

  test('returns a new array, leaves unrelated messages by identity', () => {
    const plain = { role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    const input = [plain];
    const out = stripUiOnlyDiffParts(input);
    expect(out).not.toBe(input);
    expect(out[0]).toBe(plain); // untouched messages are not cloned
  });

  test('rewrites only the tool parts that actually carry inlineSegments', () => {
    const keep = { type: 'text', text: 'some prose' };
    const toolPart = {
      type: 'tool-modify',
      output: { diff: { lines: ['-a', '+b'], inlineSegments: { 0: [] } } },
    };
    const otherTool = { type: 'tool-read_document', output: { content: 'x' } };
    const msg = { role: 'assistant', parts: [keep, toolPart, otherTool] };

    const [outMsg] = stripUiOnlyDiffParts([msg]);
    expect(outMsg.parts).toHaveLength(3);
    expect(outMsg.parts[0]).toBe(keep);
    expect(outMsg.parts[1].output.diff).not.toHaveProperty('inlineSegments');
    expect(outMsg.parts[1].output.diff.lines).toEqual(['-a', '+b']);
    expect(outMsg.parts[2]).toBe(otherTool);
    // Input untouched.
    expect(toolPart.output.diff.inlineSegments).toBeDefined();
  });

  test('tolerates non-array input and messages without parts', () => {
    expect(stripUiOnlyDiffParts(null)).toBe(null);
    expect(stripUiOnlyDiffParts(undefined)).toBe(undefined);
    const noParts = { role: 'user' };
    expect(stripUiOnlyDiffParts([noParts])[0]).toBe(noParts);
  });
});
