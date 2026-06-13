/**
 * Regression test for the Anthropic web-search "swallowed message" bug.
 *
 * When a provider-executed web search ran in the same assistant step as a client
 * tool call, persisting and replaying that turn made convertToModelMessages emit
 * an assistant message where the client `tool_use` block was no longer trailing
 * (an inline `web_search_tool_result` sat after it). Anthropic rejects that with a
 * 400 (`tool_use ids ... without tool_result blocks`), surfaced as a dead spinner.
 *
 * stripProviderExecutedTools removes those provider-executed blocks from what we
 * send, restoring the required tool_use/tool_result adjacency. These tests pin both
 * the helper's behavior and the end-to-end conversion invariant.
 */
const { convertToModelMessages } = require('ai');
const { stripProviderExecutedTools } = require('../api/chat-models');

// Minimal fixture mirroring prod: a client tool call (`list_documents`) and a
// provider-executed `webSearch` end the same assistant step.
function poisonedHistory() {
  return [
    { role: 'user', id: 'u1', parts: [{ type: 'text', text: 'research X' }] },
    {
      role: 'assistant',
      id: 'a1',
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'Looking.', state: 'done' },
        { type: 'tool-list_documents', toolCallId: 'toolu_a', state: 'output-available', input: {}, output: { docs: [] } },
        {
          type: 'tool-webSearch', toolCallId: 'srvtoolu_x', state: 'output-available', providerExecuted: true,
          input: { query: 'X' },
          output: [{ type: 'web_search_result', url: 'http://e.com', title: 'T', encryptedContent: 'ENC' }],
        },
      ],
    },
    { role: 'user', id: 'u2', parts: [{ type: 'text', text: 'thanks' }] },
  ];
}

const assistantToolResults = (modelMessages) =>
  modelMessages
    .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
    .flatMap((m) => m.content)
    .filter((c) => c.type === 'tool-result');

describe('stripProviderExecutedTools', () => {
  test('removes provider-executed tool parts from assistant turns', () => {
    const out = stripProviderExecutedTools(poisonedHistory());
    const asst = out.find((m) => m.role === 'assistant');
    expect(asst.parts.some((p) => p.type === 'tool-webSearch')).toBe(false);
    expect(asst.parts.some((p) => p.type === 'tool-list_documents')).toBe(true); // client tool kept
    expect(asst.parts.some((p) => p.type === 'text')).toBe(true);
  });

  test('does not mutate the input array or its parts', () => {
    const input = poisonedHistory();
    const before = JSON.stringify(input);
    stripProviderExecutedTools(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  test('leaves user messages untouched', () => {
    const out = stripProviderExecutedTools(poisonedHistory());
    expect(out.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  test('drops assistant turns left empty after stripping', () => {
    const onlyServerTool = [
      { role: 'user', id: 'u1', parts: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant', id: 'a1', parts: [
          { type: 'tool-webSearch', toolCallId: 'srvtoolu_y', state: 'output-available', providerExecuted: true, input: { query: 'q' }, output: [] },
        ],
      },
    ];
    const out = stripProviderExecutedTools(onlyServerTool);
    expect(out.find((m) => m.role === 'assistant')).toBeUndefined();
    expect(out).toHaveLength(1);
  });

  test('is a no-op when there is nothing to strip (e.g. Google client-tool web search)', () => {
    const clean = [
      { role: 'user', id: 'u1', parts: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant', id: 'a1', parts: [
          { type: 'text', text: 'searched', state: 'done' },
          { type: 'tool-webSearch', toolCallId: 'toolu_z', state: 'output-available', input: { query: 'q' }, output: { text: 'r' } }, // client tool: no providerExecuted
        ],
      },
    ];
    expect(stripProviderExecutedTools(clean)).toEqual(clean);
  });

  test('passes through non-array input unchanged', () => {
    expect(stripProviderExecutedTools(undefined)).toBeUndefined();
  });
});

describe('conversion invariant (the actual bug)', () => {
  test('RAW poisoned history converts to an assistant message holding a stray tool-result (documents the bug)', async () => {
    const mm = await convertToModelMessages(poisonedHistory());
    // The web_search tool-result ends up INSIDE an assistant message — this is what
    // breaks the client tool_use/tool_result adjacency and triggers Anthropic's 400.
    expect(assistantToolResults(mm).length).toBeGreaterThan(0);
  });

  test('STRIPPED history converts with NO tool-result inside any assistant message (fix)', async () => {
    const mm = await convertToModelMessages(stripProviderExecutedTools(poisonedHistory()));
    expect(assistantToolResults(mm)).toHaveLength(0);

    // And every client tool-call still has a matching tool-result in a tool message.
    const calls = mm.filter((m) => m.role === 'assistant').flatMap((m) => m.content).filter((c) => c.type === 'tool-call').map((c) => c.toolCallId);
    const results = mm.filter((m) => m.role === 'tool').flatMap((m) => m.content).filter((c) => c.type === 'tool-result').map((c) => c.toolCallId);
    for (const id of calls) expect(results).toContain(id);
  });
});
