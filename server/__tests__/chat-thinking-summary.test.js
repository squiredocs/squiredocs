/**
 * POST /thinking-summary tests
 *
 * The chat UI polls this endpoint while a reasoning block streams; a cheap
 * model condenses the accumulated thinking into a short live label.
 * Uses supertest with mocked auth and a mocked AI SDK — no database needed.
 */
const express = require('express');
const request = require('supertest');

// Mock requireAuth to always pass with a fake user
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => {
    req.user = { userId: 'test-user' };
    next();
  },
}));

// Mock all heavy dependencies so requiring chat.js doesn't pull them in
jest.mock('../auth/jwt', () => ({ extractBearerToken: jest.fn() }));
jest.mock('../mcp/auth/agent-token-factory', () => ({ createAgentTokenPair: jest.fn() }));
jest.mock('../url', () => ({ buildBaseUrl: jest.fn() }));
jest.mock('../api/chat-tools', () => ({ buildTools: jest.fn(() => ({})) }));
const mockGetThinkingSummaryModels = jest.fn(() => [
  { id: 'primary', model: 'summary-model' },
]);
jest.mock('../api/chat-models', () => ({
  DEFAULT_MODEL_KEY: 'test',
  resolveModel: jest.fn(),
  getThinkingSummaryModels: (...args) => mockGetThinkingSummaryModels(...args),
}));
jest.mock('../documents', () => ({ getDocument: jest.fn() }));
jest.mock('../chat-store', () => ({
  loadChat: jest.fn(),
  saveChat: jest.fn(),
  createChat: jest.fn(),
  getChatsForUser: jest.fn(),
  deleteChat: jest.fn(),
  updateChatTitle: jest.fn(),
}));
jest.mock('../ai-usage', () => ({
  checkQuota: jest.fn(),
  computeCostCents: jest.fn(),
  recordUsage: jest.fn(),
}));

const mockGenerateText = jest.fn();
jest.mock('ai', () => ({ generateText: (...args) => mockGenerateText(...args) }));

const { router, _resetThinkingSummaryCooldowns } = require('../api/chat');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

describe('POST /thinking-summary', () => {
  let app;

  beforeEach(() => {
    mockGenerateText.mockReset();
    mockGetThinkingSummaryModels.mockReset()
      .mockReturnValue([{ id: 'primary', model: 'summary-model' }]);
    _resetThinkingSummaryCooldowns();
    app = buildApp();
  });

  test('returns 400 when text is missing or blank', async () => {
    expect((await request(app).post('/thinking-summary').send({})).status).toBe(400);
    expect((await request(app).post('/thinking-summary').send({ text: '   ' })).status).toBe(400);
    expect((await request(app).post('/thinking-summary').send({ text: 42 })).status).toBe(400);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test('summarizes the thinking text with the cheap summary model', async () => {
    mockGenerateText.mockResolvedValue({ text: ' "Planning the document outline" ' });

    const res = await request(app)
      .post('/thinking-summary')
      .send({ text: 'The user wants an outline, so first I should...' });

    expect(res.status).toBe(200);
    // Surrounding whitespace and quotes are stripped from the model output
    expect(res.body).toEqual({ summary: 'Planning the document outline' });

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.model).toBe('summary-model');
    expect(call.prompt).toContain('The user wants an outline, so first I should...');
  });

  test('only sends the tail of very long thinking text to the model', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Summarizing' });
    const text = 'HEAD-MARKER '.padEnd(9000, 'x') + 'TAIL-MARKER';

    await request(app).post('/thinking-summary').send({ text });

    const { prompt } = mockGenerateText.mock.calls[0][0];
    expect(prompt).toContain('TAIL-MARKER');
    expect(prompt).not.toContain('HEAD-MARKER');
  });

  test('returns null summary when the model returns nothing', async () => {
    mockGenerateText.mockResolvedValue({ text: '' });

    const res = await request(app).post('/thinking-summary').send({ text: 'thinking...' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: null });
  });

  test('fails over to the next candidate when the first model call fails', async () => {
    mockGetThinkingSummaryModels.mockReturnValue([
      { id: 'anthropic:haiku', model: 'haiku' },
      { id: 'openrouter:glm', model: 'glm' },
    ]);
    mockGenerateText
      .mockRejectedValueOnce(new Error('credit balance is too low'))
      .mockResolvedValueOnce({ text: 'Reading the document' });

    const res = await request(app).post('/thinking-summary').send({ text: 'thinking...' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: 'Reading the document' });
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(mockGenerateText.mock.calls[0][0].model).toBe('haiku');
    expect(mockGenerateText.mock.calls[1][0].model).toBe('glm');
  });

  test('a failed candidate cools down: the next poll skips straight to the fallback', async () => {
    mockGetThinkingSummaryModels.mockReturnValue([
      { id: 'anthropic:haiku', model: 'haiku' },
      { id: 'openrouter:glm', model: 'glm' },
    ]);
    mockGenerateText
      .mockRejectedValueOnce(new Error('credit balance is too low'))
      .mockResolvedValue({ text: 'Summarizing' });

    await request(app).post('/thinking-summary').send({ text: 'thinking...' });
    mockGenerateText.mockClear();
    mockGenerateText.mockResolvedValue({ text: 'Still summarizing' });

    const res = await request(app).post('/thinking-summary').send({ text: 'more thinking...' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: 'Still summarizing' });
    // The cooled-down primary is skipped entirely — one call, on the fallback.
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockGenerateText.mock.calls[0][0].model).toBe('glm');
  });

  test('degrades to summary:null (200, never 500) when every candidate fails', async () => {
    mockGetThinkingSummaryModels.mockReturnValue([
      { id: 'anthropic:haiku', model: 'haiku' },
      { id: 'openrouter:glm', model: 'glm' },
    ]);
    mockGenerateText.mockRejectedValue(new Error('provider down'));

    const res = await request(app).post('/thinking-summary').send({ text: 'thinking...' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: null });
  });

  test('degrades to summary:null when no shared-key candidates exist at all', async () => {
    mockGetThinkingSummaryModels.mockReturnValue([]);

    const res = await request(app).post('/thinking-summary').send({ text: 'thinking...' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: null });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});
