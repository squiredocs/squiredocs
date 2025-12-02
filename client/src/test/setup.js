import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Mock import.meta.env for all tests
Object.defineProperty(import.meta, 'env', {
  value: {
    VITE_WS_URL: 'ws://localhost:3001/s'
  },
  writable: false
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

