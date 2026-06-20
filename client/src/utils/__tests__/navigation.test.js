import { describe, it, expect } from 'vitest';
import { parseDocGuid } from '../navigation';

describe('parseDocGuid', () => {
  it('extracts the guid from /d/<guid>', () => {
    expect(parseDocGuid('/d/abc-123')).toBe('abc-123');
  });

  it('extracts the guid from the /doc/<guid> alias', () => {
    expect(parseDocGuid('/doc/abc-123')).toBe('abc-123');
  });

  it('lowercases the guid', () => {
    expect(parseDocGuid('/d/ABC-DEF')).toBe('abc-def');
  });

  it('ignores trailing path segments (prefix match)', () => {
    expect(parseDocGuid('/d/abc-123/versions')).toBe('abc-123');
  });

  it('returns null for non-doc paths', () => {
    expect(parseDocGuid('/chat')).toBeNull();
    expect(parseDocGuid('/docs')).toBeNull();
    expect(parseDocGuid('/')).toBeNull();
  });

  it('returns null for empty/missing input', () => {
    expect(parseDocGuid('')).toBeNull();
    expect(parseDocGuid(undefined)).toBeNull();
  });
});
