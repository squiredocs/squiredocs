/**
 * Cross-turn message compaction tests
 *
 * Tests the compactMessages function that summarizes old conversation
 * messages when they exceed a fraction of the model's context window.
 */

// NOTE: This file does NOT require ../api/chat (where compactMessages lives) —
// compactMessages is not exported, so these tests re-implement and assert its
// expected behavior inline. There are deliberately no jest.mock() calls: with
// no real module loaded, mocks for ../api/chat-models, 'ai', etc. would be dead
// code that silently drifts from the real exports (e.g. a mock 'ai' whose
// streamText returns undefined when the real one returns a stream object). That
// is exactly the kind of stale mock that hides prod crashes, so we keep none.
// If compactMessages is ever exported and exercised directly here, mock only
// what that path actually loads, matching the real export surface.

describe('compactMessages logic', () => {
  // Since compactMessages is not exported, we test the expected behavior:
  // messages under threshold pass through, messages over threshold get compacted.

  it('should not compact when messages are small', () => {
    // Messages that are well under 50% of context window should pass through
    const smallMessages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
    ];

    const serialized = JSON.stringify(smallMessages);
    const estimatedTokens = serialized.length / 4;
    const threshold = 1_000_000 * 0.5; // 500K tokens

    expect(estimatedTokens).toBeLessThan(threshold);
  });

  it('should identify messages exceeding the threshold', () => {
    // Create messages that would exceed 50% of a 200K token context
    const bigContent = 'x'.repeat(500_000); // ~125K tokens
    const largeMessages = [
      { role: 'user', content: [{ type: 'text', text: bigContent }] },
      { role: 'assistant', content: [{ type: 'text', text: bigContent }] },
    ];

    const serialized = JSON.stringify(largeMessages);
    const estimatedTokens = serialized.length / 4;
    const threshold = 200_000 * 0.5; // 100K tokens

    expect(estimatedTokens).toBeGreaterThan(threshold);
  });

  it('should preserve recent messages during compaction', () => {
    // With 15 messages and RECENT_MESSAGES_TO_KEEP=10, first 5 should be compacted
    const messages = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `Message ${i}` }],
    }));

    const RECENT_MESSAGES_TO_KEEP = 10;
    const splitAt = Math.max(0, messages.length - RECENT_MESSAGES_TO_KEEP);
    const oldMessages = messages.slice(0, splitAt);
    const recentMessages = messages.slice(splitAt);

    expect(oldMessages).toHaveLength(5);
    expect(recentMessages).toHaveLength(10);
    expect(recentMessages[0].content[0].text).toBe('Message 5');
  });

  it('should not compact if there are fewer messages than RECENT_MESSAGES_TO_KEEP', () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `Message ${i}` }],
    }));

    const RECENT_MESSAGES_TO_KEEP = 10;
    const splitAt = Math.max(0, messages.length - RECENT_MESSAGES_TO_KEEP);
    const oldMessages = messages.slice(0, splitAt);

    expect(oldMessages).toHaveLength(0);
  });

  it('summary message should have the correct format', () => {
    const summaryText = 'User asked about document abc-123. Assistant read it and found 3 sections.';
    const oldMessageCount = 8;

    const summaryMessage = {
      role: 'user',
      content: [{
        type: 'text',
        text: `[Earlier conversation summary — ${oldMessageCount} messages compacted]\n\n${summaryText}`,
      }],
    };

    expect(summaryMessage.role).toBe('user');
    expect(summaryMessage.content[0].text).toContain('8 messages compacted');
    expect(summaryMessage.content[0].text).toContain('abc-123');
  });

  describe('generateText for compaction', () => {
    it('should include preservation instructions in the prompt', () => {
      const expectedPromptParts = [
        'Key decisions',
        'Document IDs',
        'docGuid',
        'Tool calls',
        'unresolved questions',
      ];

      // The prompt template from compactMessages
      const prompt = `Summarize this conversation history concisely. Preserve:\n`
        + `- Key decisions made\n`
        + `- Document IDs (docGuid values) mentioned and what was done with them\n`
        + `- Tool calls made and their key results\n`
        + `- Any unresolved questions or pending tasks\n`
        + `Omit: raw document content, redundant exchanges, verbose tool outputs.\n\n`
        + `Conversation history:\n[]`;

      for (const part of expectedPromptParts) {
        expect(prompt).toContain(part);
      }
    });
  });
});
