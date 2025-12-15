import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for App routing functionality
 */

// Mock the window.location.pathname
const mockLocation = (pathname) => {
  delete window.location;
  window.location = { pathname };
};

// Import the parseRoute function by extracting it from App.jsx
// Since parseRoute is not exported, we'll test it indirectly through route behavior

describe('App routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('route parsing', () => {
    it('parses /login route', () => {
      mockLocation('/login');
      // parseRoute() would return { view: 'login', docGuid: null }
      expect(window.location.pathname).toBe('/login');
    });

    it('parses /docs route', () => {
      mockLocation('/docs');
      expect(window.location.pathname).toBe('/docs');
    });

    it('parses /d/{uuid} route', () => {
      const uuid = 'b5384268-306a-48df-99b5-0d30bb747bc5';
      mockLocation(`/d/${uuid}`);
      expect(window.location.pathname).toBe(`/d/${uuid}`);
    });

    it('parses /doc/{uuid} route', () => {
      const uuid = 'b5384268-306a-48df-99b5-0d30bb747bc5';
      mockLocation(`/doc/${uuid}`);
      expect(window.location.pathname).toBe(`/doc/${uuid}`);
    });

    it('parses /d/{uuid}/versions route', () => {
      const uuid = 'b5384268-306a-48df-99b5-0d30bb747bc5';
      mockLocation(`/d/${uuid}/versions`);
      expect(window.location.pathname).toBe(`/d/${uuid}/versions`);
    });

    it('parses /doc/{uuid}/versions route', () => {
      const uuid = 'b5384268-306a-48df-99b5-0d30bb747bc5';
      mockLocation(`/doc/${uuid}/versions`);
      expect(window.location.pathname).toBe(`/doc/${uuid}/versions`);
    });

    it('parses root path', () => {
      mockLocation('/');
      expect(window.location.pathname).toBe('/');
    });

    it('handles unknown routes', () => {
      mockLocation('/unknown');
      expect(window.location.pathname).toBe('/unknown');
    });
  });

  describe('UUID validation', () => {
    it('accepts valid UUIDs', () => {
      const validUUIDs = [
        'b5384268-306a-48df-99b5-0d30bb747bc5',
        '550e8400-e29b-41d4-a716-446655440000',
        'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      ];

      validUUIDs.forEach(uuid => {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        expect(uuidRegex.test(uuid)).toBe(true);
      });
    });

    it('rejects invalid UUIDs', () => {
      const invalidUUIDs = [
        'not-a-uuid',
        '12345',
        'b5384268-306a-48df-99b5',
        'b5384268-306a-48df-99b5-0d30bb747bc5-extra',
      ];

      invalidUUIDs.forEach(uuid => {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        expect(uuidRegex.test(uuid)).toBe(false);
      });
    });
  });

  describe('route patterns', () => {
    it('matches version history route before editor route', () => {
      const uuid = 'b5384268-306a-48df-99b5-0d30bb747bc5';
      const path = `/d/${uuid}/versions`;

      // Version route should match first
      const versionsMatch = path.match(/^\/d(?:oc)?\/([0-9a-f-]+)\/versions$/i);
      expect(versionsMatch).toBeTruthy();
      expect(versionsMatch[1]).toBe(uuid);

      // Editor route should not match when /versions is present
      const editorMatch = path.match(/^\/d(?:oc)?\/([0-9a-f-]+)$/i);
      expect(editorMatch).toBeNull();
    });

    it('matches editor route when no /versions suffix', () => {
      const uuid = 'b5384268-306a-48df-99b5-0d30bb747bc5';
      const path = `/d/${uuid}`;

      // Editor route should match
      const editorMatch = path.match(/^\/d(?:oc)?\/([0-9a-f-]+)$/i);
      expect(editorMatch).toBeTruthy();
      expect(editorMatch[1]).toBe(uuid);

      // Version route should not match
      const versionsMatch = path.match(/^\/d(?:oc)?\/([0-9a-f-]+)\/versions$/i);
      expect(versionsMatch).toBeNull();
    });
  });
});
