/**
 * Feature 018 US2 — contextualizer unit tests (T018).
 *
 * The ai SDK and the chat-models registry are mocked: generateObject is a
 * controllable spy, so batching shape, fail-soft behavior, and registry
 * routing are provable without any provider (RBD-4, FR-013/FR-016/FR-017).
 */
const mockGenerateObject = jest.fn();
jest.mock('ai', () => ({
  generateObject: (...args) => mockGenerateObject(...args),
  jsonSchema: (schema) => schema,
}));

const mockGetContextualizerModel = jest.fn(() => 'registry-contextualizer-model');
jest.mock('../api/chat-models', () => ({
  getContextualizerModel: (...args) => mockGetContextualizerModel(...args),
}));

const { contextualizeChunks, MAX_CHUNKS_PER_CALL, MAX_DOC_CHARS } = require('../search/contextualizer');

const chunk = (i) => ({ text: `Chunk body number ${i}.`, headingPath: ['Section', `Sub ${i}`] });

describe('contextualizeChunks (T018)', () => {
  let savedApiKey;

  beforeAll(() => {
    savedApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  });

  afterAll(() => {
    if (savedApiKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = savedApiKey;
  });

  beforeEach(() => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key-ctx';
    mockGenerateObject.mockReset();
    mockGetContextualizerModel.mockClear();
  });

  test('(a) batching: ≤25 chunks per call, document sent once per batch, 120K-char cap (FR-017)', async () => {
    const chunks = Array.from({ length: 30 }, (_, i) => chunk(i));
    mockGenerateObject.mockImplementation(async ({ prompt }) => {
      const count = (prompt.match(/\[\d+\]/g) || []).length;
      return { object: { contexts: Array.from({ length: count }, (_, i) => `ctx ${i}`) } };
    });

    const bigDoc = 'D'.repeat(150_000);
    const out = await contextualizeChunks({ docTitle: 'Big Doc', fullText: bigDoc, chunks });

    expect(mockGenerateObject).toHaveBeenCalledTimes(2); // ceil(30/25)
    expect(out.length).toBe(30);
    for (const call of mockGenerateObject.mock.calls) {
      const { prompt } = call[0];
      // Document included once, capped at MAX_DOC_CHARS
      const docMatch = prompt.match(/<document>\n(D+)\n<\/document>/);
      expect(docMatch).not.toBeNull();
      expect(docMatch[1].length).toBe(MAX_DOC_CHARS);
      // Chunk heading trails ride along
      expect(prompt).toContain('Section > Sub');
    }
    // First batch got 25 chunks, second got 5
    const counts = mockGenerateObject.mock.calls.map(
      ([{ prompt }]) => (prompt.match(/\[\d+\] section:/g) || []).length
    );
    expect(counts).toEqual([MAX_CHUNKS_PER_CALL, 5]);
  });

  test('(b) best-effort per batch: one failing batch yields empty preambles, others keep theirs (FR-016)', async () => {
    const chunks = Array.from({ length: 30 }, (_, i) => chunk(i));
    let call = 0;
    mockGenerateObject.mockImplementation(async ({ prompt }) => {
      call++;
      if (call === 1) throw new Error('provider exploded');
      const count = (prompt.match(/\[\d+\] section:/g) || []).length;
      return { object: { contexts: Array.from({ length: count }, (_, i) => `late ctx ${i}`) } };
    });

    const out = await contextualizeChunks({ docTitle: 'Doc', fullText: 'text', chunks });
    expect(out.length).toBe(30);
    expect(out.slice(0, 25).every((c) => c === '')).toBe(true); // failed batch
    expect(out.slice(25).every((c) => c.startsWith('late ctx'))).toBe(true);
  });

  test('(c) total failure or missing key ⇒ all-empty, never throws', async () => {
    const chunks = [chunk(1), chunk(2)];
    mockGenerateObject.mockRejectedValue(new Error('all down'));
    await expect(contextualizeChunks({ docTitle: 'D', fullText: 'T', chunks })).resolves.toEqual(['', '']);

    mockGenerateObject.mockReset();
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const out = await contextualizeChunks({ docTitle: 'D', fullText: 'T', chunks });
    expect(out).toEqual(['', '']);
    expect(mockGenerateObject).not.toHaveBeenCalled();

    // Empty input short-circuits
    expect(await contextualizeChunks({ docTitle: 'D', fullText: 'T', chunks: [] })).toEqual([]);
  });

  test('(d) output aligned to chunk order and count; non-strings coerced to empty', async () => {
    const chunks = [chunk(1), chunk(2), chunk(3)];
    mockGenerateObject.mockResolvedValue({
      object: { contexts: ['first ok', 42, undefined, 'excess dropped'] },
    });
    const out = await contextualizeChunks({ docTitle: 'D', fullText: 'T', chunks });
    expect(out).toEqual(['first ok', '', '']);
  });

  test('(e) model comes from the chat-models registry (Constitution constraint, D6)', async () => {
    mockGenerateObject.mockResolvedValue({ object: { contexts: ['a', 'b'] } });
    await contextualizeChunks({ docTitle: 'D', fullText: 'T', chunks: [chunk(1), chunk(2)] });
    expect(mockGetContextualizerModel).toHaveBeenCalled();
    expect(mockGenerateObject.mock.calls[0][0].model).toBe('registry-contextualizer-model');
  });

  test('prompt asks for 1–3 situating sentences (FR-013)', async () => {
    mockGenerateObject.mockResolvedValue({ object: { contexts: ['a', 'b'] } });
    await contextualizeChunks({ docTitle: 'D', fullText: 'T', chunks: [chunk(1), chunk(2)] });
    expect(mockGenerateObject.mock.calls[0][0].prompt).toMatch(/1-3 sentence/);
  });
});
