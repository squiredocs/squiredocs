/**
 * AuthContext Tests
 *
 * Tests the authentication context hook behavior.
 * Note: Full integration testing of OAuth flow and 401 interceptors
 * is covered in the server-side tests (routes.test.js).
 * These tests focus on the React hook behavior.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAuth } from '../AuthContext';

describe('AuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('useAuth hook', () => {
    it('throws error when used outside AuthProvider', () => {
      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        renderHook(() => useAuth());
      }).toThrow('useAuth must be used within an AuthProvider');

      consoleSpy.mockRestore();
    });
  });

  // Note: The following behaviors are tested via:
  // - server/auth/__tests__/routes.test.js: OAuth flow, token refresh, logout
  // - hooks/__tests__/useYjs.auth.test.js: clearYjsInstanceCache integration
  // - components/__tests__/EditorView.banners.test.jsx: Banner states with auth errors
  //
  // Full AuthContext integration tests require complex axios mocking that is
  // better suited for E2E testing or the server-side tests.
});
