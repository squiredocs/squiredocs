import React from 'react';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

/**
 * Test utilities for React component testing
 */

// Reset Yjs singletons for testing
export function resetYjsSingletons() {
  if (typeof global !== 'undefined') {
    global.__TEST_RESET_YJS_SINGLETONS__ = true;
    // Don't require the module here to avoid race conditions
    // The module will check for this flag when imported
  }
}

export function createMockYjsProvider() {
  const doc = new Y.Doc();
  const awareness = {
    getLocalState: () => ({ user: { name: 'Test User', color: '#000000' } }),
    getStates: () => new Map(),
    on: vi.fn(),
    off: vi.fn(),
    setLocalStateField: vi.fn()
  };
  
  const provider = {
    doc,
    awareness,
    shouldConnect: true,
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn()
  };
  
  return { doc, provider, awareness };
}

// Mock TipTap editor
export function createMockEditor() {
  const runFn = vi.fn();
  const chainFn = vi.fn(() => ({
    focus: vi.fn(() => ({
      toggleBold: vi.fn(() => ({ run: runFn })),
      toggleItalic: vi.fn(() => ({ run: runFn })),
      toggleUnderline: vi.fn(() => ({ run: runFn })),
      toggleStrike: vi.fn(() => ({ run: runFn })),
      toggleHeading: vi.fn(() => ({ run: runFn })),
      toggleBulletList: vi.fn(() => ({ run: runFn })),
      toggleOrderedList: vi.fn(() => ({ run: runFn })),
      toggleCode: vi.fn(() => ({ run: runFn })),
      run: runFn
    }))
  }));
  
  return {
    chain: chainFn,
    isActive: vi.fn(() => false),
    extensionManager: {
      extensions: []
    }
  };
}

// Custom render with providers
export function renderWithProviders(ui, options = {}) {
  const { ydoc, provider, awareness } = options.yjs || createMockYjsProvider();
  
  const Wrapper = ({ children }) => {
    return <>{children}</>;
  };
  
  return render(ui, { wrapper: Wrapper, ...options });
}

// Wait for async updates
export const waitForAsync = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Create a controllable mock WebSocket provider for testing auth/reconnection scenarios.
 * Use _emit* methods to simulate events from the provider.
 */
export function createControllableMockProvider(options = {}) {
  const eventHandlers = new Map();

  const mockAwareness = {
    clientID: Math.floor(Math.random() * 1000000),
    getLocalState: vi.fn(() => ({})),
    getStates: vi.fn(() => new Map()),
    on: vi.fn((event, handler) => {
      if (!eventHandlers.has(`awareness:${event}`)) {
        eventHandlers.set(`awareness:${event}`, []);
      }
      eventHandlers.get(`awareness:${event}`).push(handler);
    }),
    off: vi.fn((event, handler) => {
      const key = `awareness:${event}`;
      if (eventHandlers.has(key)) {
        const handlers = eventHandlers.get(key);
        const idx = handlers.indexOf(handler);
        if (idx > -1) handlers.splice(idx, 1);
      }
    }),
    setLocalStateField: vi.fn()
  };

  const mockProvider = {
    doc: options.doc || new Y.Doc(),
    awareness: mockAwareness,
    shouldConnect: true,
    synced: options.synced ?? false,
    wsconnected: options.wsconnected ?? false,
    wsUnsuccessful: 0,

    // Event management
    on: vi.fn((event, handler) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, []);
      }
      eventHandlers.get(event).push(handler);
    }),

    off: vi.fn((event, handler) => {
      if (eventHandlers.has(event)) {
        const handlers = eventHandlers.get(event);
        const idx = handlers.indexOf(handler);
        if (idx > -1) handlers.splice(idx, 1);
      }
    }),

    once: vi.fn((event, handler) => {
      const wrapper = (...args) => {
        handler(...args);
        mockProvider.off(event, wrapper);
      };
      mockProvider.on(event, wrapper);
    }),

    // Actions
    connect: vi.fn(),
    disconnect: vi.fn(),
    destroy: vi.fn(),

    // === Test utilities for emitting events ===

    /**
     * Emit a raw event to all registered handlers
     */
    _emit: (event, data) => {
      const handlers = eventHandlers.get(event) || [];
      handlers.forEach(h => h(data));
    },

    /**
     * Emit a status change event
     * @param {'connecting' | 'connected' | 'disconnected'} status
     */
    _emitStatus: (status) => {
      mockProvider.wsconnected = status === 'connected';
      mockProvider._emit('status', { status });
    },

    /**
     * Emit a sync event
     * @param {boolean} isSynced
     */
    _emitSync: (isSynced) => {
      mockProvider.synced = isSynced;
      mockProvider._emit('sync', isSynced);
    },

    /**
     * Emit a connection error event
     * @param {string} message - Error message (e.g., "401 Unauthorized")
     */
    _emitConnectionError: (message) => {
      mockProvider._emit('connection-error', new Error(message));
    },

    /**
     * Emit a connection close event
     * @param {number} code - WebSocket close code (e.g., 1008, 4401)
     * @param {string} reason - Optional close reason
     */
    _emitConnectionClose: (code, reason = '') => {
      mockProvider._emit('connection-close', { code, reason });
    },

    /**
     * Emit an awareness change event
     */
    _emitAwarenessChange: () => {
      const handlers = eventHandlers.get('awareness:change') || [];
      handlers.forEach(h => h());
    },

    /**
     * Reset the provider state for a fresh test
     */
    _reset: () => {
      eventHandlers.clear();
      mockProvider.wsconnected = false;
      mockProvider.synced = false;
      mockProvider.shouldConnect = true;
      mockProvider.connect.mockClear();
      mockProvider.disconnect.mockClear();
      mockProvider.destroy.mockClear();
    },

    /**
     * Get registered handler count for an event (useful for debugging)
     */
    _getHandlerCount: (event) => {
      return (eventHandlers.get(event) || []).length;
    }
  };

  return mockProvider;
}

/**
 * Create a mock AuthContext value for testing
 */
export function createMockAuthContext(overrides = {}) {
  const defaults = {
    user: { id: 'test-user-id', name: 'Test User', email: 'test@example.com', picture: null },
    accessToken: 'mock-access-token-12345',
    loading: false,
    error: null,
    isAuthenticated: true,
    login: vi.fn(),
    logout: vi.fn(),
    api: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      interceptors: {
        request: { use: vi.fn(), eject: vi.fn() },
        response: { use: vi.fn(), eject: vi.fn() }
      }
    },
    expireTokenForTesting: vi.fn()
  };

  return { ...defaults, ...overrides };
}

/**
 * Create a controllable promise for testing async flows.
 * Useful for controlling when API calls resolve/reject.
 */
export function createControllablePromise() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Wait for a specific condition to be true.
 * Better error messages than waitFor when debugging.
 */
export async function waitForCondition(
  condition,
  { timeout = 5000, interval = 50, message = 'Condition not met' } = {}
) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (condition()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`${message} (waited ${timeout}ms)`);
}

/**
 * Assert banner visibility state in EditorView tests.
 * Throws descriptive errors for debugging.
 */
export function assertBannerState(container, expected) {
  const text = container.textContent || '';
  const banners = {
    authError: text.includes('Session expired'),
    offline: text.includes('Offline'),
    connecting: text.includes('Connecting'),
    reconnecting: text.includes('Reconnecting'),
    syncing: text.includes('Syncing'),
  };

  Object.entries(expected).forEach(([key, expectedValue]) => {
    if (banners[key] !== expectedValue) {
      throw new Error(
        `Expected banner "${key}" to be ${expectedValue ? 'visible' : 'hidden'}, ` +
        `but it was ${banners[key] ? 'visible' : 'hidden'}. ` +
        `Full text: "${text.substring(0, 200)}"`
      );
    }
  });
}

