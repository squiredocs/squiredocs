import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { _resetAuthProvidersForTests } from '../hooks/useAuthProviders';

// Mock import.meta.env for all tests
Object.defineProperty(import.meta, 'env', {
  value: {
    VITE_WS_URL: 'ws://localhost:3001/s'
  },
  writable: false
});

// Mock localStorage
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: vi.fn((key) => store[key] || null),
    setItem: vi.fn((key, value) => {
      store[key] = value.toString();
    }),
    removeItem: vi.fn((key) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(global, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// Mock window.location
Object.defineProperty(global, 'location', {
  value: {
    pathname: '/',
    protocol: 'http:',
    host: 'localhost:5173',
  },
  writable: true,
});

// Mock crypto.randomUUID for consistent test UUIDs
Object.defineProperty(global, 'crypto', {
  value: {
    randomUUID: vi.fn(() => '12345678-1234-4123-8123-123456789abc'),
  },
  writable: true,
});

// Feature 059: GET /auth/providers answers with the hosted service's team-mode
// Google response by default, so every page renders as it did before the
// provider-driven pages. A test overrides it by stubbing fetch itself (for
// example vi.stubGlobal('fetch', ...)); other requests behave as before.
export const TEAM_GOOGLE_PROVIDERS = {
  mode: 'team',
  hasOwner: true,
  signupOpen: true,
  providers: [{ id: 'google', label: 'Google', startPath: '/auth/google' }],
};
const realFetch = globalThis.fetch;
globalThis.fetch = vi.fn((url, ...rest) => {
  if (typeof url === 'string' && url.endsWith('/auth/providers')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(TEAM_GOOGLE_PROVIDERS) });
  }
  return realFetch ? realFetch(url, ...rest) : Promise.reject(new Error('no network in tests'));
});

// Clear localStorage before each test
beforeEach(() => {
  localStorageMock.clear();
  vi.clearAllMocks();
  _resetAuthProvidersForTests();
});

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  takeRecords() {
    return [];
  }
  unobserve() {}
};

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  unobserve() {}
};

// Suppress console errors in tests unless needed
global.console = {
  ...console,
  error: vi.fn(),
  warn: vi.fn(),
};

