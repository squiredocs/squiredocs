import { describe, it, expect } from 'vitest';
import { isTokenExpired, isTokenExpiringSoon, decodeToken } from '../jwt';

// Helper: build a JWT-shaped token with a given exp (seconds since epoch)
function fakeJwt(exp) {
  const header = btoa(JSON.stringify({ alg: 'HS256' }));
  const payload = btoa(JSON.stringify({ exp }));
  return `${header}.${payload}.sig`;
}

function fakeJwtNoExp() {
  const header = btoa(JSON.stringify({ alg: 'HS256' }));
  const payload = btoa(JSON.stringify({ sub: 'user1' }));
  return `${header}.${payload}.sig`;
}

describe('isTokenExpiringSoon', () => {
  it('returns true for null/undefined token', () => {
    expect(isTokenExpiringSoon(null)).toBe(true);
    expect(isTokenExpiringSoon(undefined)).toBe(true);
    expect(isTokenExpiringSoon('')).toBe(true);
  });

  it('returns true for malformed token', () => {
    expect(isTokenExpiringSoon('not-a-jwt')).toBe(true);
  });

  it('returns true for already expired token', () => {
    const expired = fakeJwt(Math.floor(Date.now() / 1000) - 60);
    expect(isTokenExpiringSoon(expired)).toBe(true);
  });

  it('returns true when token expires within default margin (60s)', () => {
    const expiresIn30s = fakeJwt(Math.floor(Date.now() / 1000) + 30);
    expect(isTokenExpiringSoon(expiresIn30s)).toBe(true);
  });

  it('returns false when token has plenty of time left', () => {
    const expiresIn10m = fakeJwt(Math.floor(Date.now() / 1000) + 600);
    expect(isTokenExpiringSoon(expiresIn10m)).toBe(false);
  });

  it('respects custom margin parameter', () => {
    const expiresIn90s = fakeJwt(Math.floor(Date.now() / 1000) + 90);
    // Within 120s margin → expiring soon
    expect(isTokenExpiringSoon(expiresIn90s, 120)).toBe(true);
    // Within 60s margin → not expiring soon
    expect(isTokenExpiringSoon(expiresIn90s, 60)).toBe(false);
  });

  it('returns false for token without exp claim', () => {
    expect(isTokenExpiringSoon(fakeJwtNoExp())).toBe(false);
  });
});

describe('isTokenExpired', () => {
  it('returns true for expired token', () => {
    const expired = fakeJwt(Math.floor(Date.now() / 1000) - 10);
    expect(isTokenExpired(expired)).toBe(true);
  });

  it('returns false for valid token', () => {
    const valid = fakeJwt(Math.floor(Date.now() / 1000) + 600);
    expect(isTokenExpired(valid)).toBe(false);
  });
});

describe('decodeToken', () => {
  it('returns payload for valid token', () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const token = fakeJwt(exp);
    expect(decodeToken(token)).toEqual({ exp });
  });

  it('returns null for invalid token', () => {
    expect(decodeToken(null)).toBeNull();
    expect(decodeToken('bad')).toBeNull();
  });
});
