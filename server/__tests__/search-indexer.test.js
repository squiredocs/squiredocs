/**
 * Tests for the search indexer module
 */
const { chunkText } = require('../search-indexer');

describe('chunkText', () => {
  test('returns single chunk for short text', () => {
    const text = 'Hello world';
    const chunks = chunkText(text);
    expect(chunks).toEqual(['Hello world']);
  });

  test('returns empty array for empty text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText(null)).toEqual([]);
    expect(chunkText(undefined)).toEqual([]);
  });

  test('returns single chunk when text equals chunk size', () => {
    const text = 'a'.repeat(6000);
    const chunks = chunkText(text);
    expect(chunks).toEqual([text]);
  });

  test('splits text into overlapping chunks', () => {
    // 10000 chars with 6000 chunk size and 500 overlap = 5500 step
    // chunk 0: 0-6000, chunk 1: 5500-11500 (but text is 10000, so 5500-10000)
    const text = 'a'.repeat(10000);
    const chunks = chunkText(text, 6000, 500);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(6000);
    expect(chunks[1].length).toBe(4500); // 10000 - 5500
  });

  test('skips chunks shorter than minimum length', () => {
    // chunkSize=5500, overlap=500, step=5000
    // text=10050: i=0 => 5500 chars, i=5000 => 5050 chars, i=10000 => 50 chars (<100, skipped)
    const text = 'a'.repeat(10050);
    const chunks = chunkText(text, 5500, 500);
    expect(chunks.length).toBe(2);

    // Verify the 50-char trailing fragment was indeed skipped
    expect(chunks[0].length).toBe(5500);
    expect(chunks[1].length).toBe(5050);
  });

  test('chunks overlap correctly', () => {
    const text = 'abcdefghij'.repeat(1000); // 10000 chars
    const chunks = chunkText(text, 6000, 500);

    // The end of chunk 0 should match the start of chunk 1
    const overlap0End = chunks[0].slice(-500);
    const overlap1Start = chunks[1].slice(0, 500);
    expect(overlap0End).toBe(overlap1Start);
  });

  test('handles custom chunk size and overlap', () => {
    const text = 'x'.repeat(1000);
    const chunks = chunkText(text, 300, 50);
    // step = 250, so chunks at 0, 250, 500, 750
    expect(chunks.length).toBe(4);
    expect(chunks[0].length).toBe(300);
    expect(chunks[1].length).toBe(300);
    expect(chunks[2].length).toBe(300);
    expect(chunks[3].length).toBe(250); // 1000 - 750
  });
});
