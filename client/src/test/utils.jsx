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

