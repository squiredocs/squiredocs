/**
 * Full-mount regression tests for App's authenticated views.
 *
 * Why this exists (053 post-ship bug, 2026-08-07): App.jsx has two components —
 * AppContent defines the navigate* callbacks, AuthenticatedApp receives them as
 * props. A callback defined in AppContent but never threaded through
 * AuthenticatedApp's prop list crashes the whole page with a ReferenceError the
 * moment that view renders (navigateToSpace at App.jsx:408 shipped exactly this
 * way — DocList unit tests could not see it because the bug lives in the wiring
 * between the two components, not in either component).
 *
 * These tests mount the REAL App (real AppContent + real AuthenticatedApp) with
 * the page-level children mocked, so every navigate* identifier in each view's
 * JSX gets evaluated. A missing prop fails loudly here.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock the auth context: authenticated, non-loading user.
const mockApi = {
  get: async () => ({ data: {} }),
  post: async () => ({ data: {} }),
  put: async () => ({ data: {} }),
  delete: async () => ({ data: {} }),
};
vi.mock('../contexts/AuthContext', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => ({
    user: { id: 'u-1', name: 'Test User', email: 'test@example.com', isAdmin: false },
    loading: false,
    isAuthenticated: true,
    accessToken: 'test-token',
    api: mockApi,
  }),
}));

// Mock the page-level children: each records the props it was handed. The
// wiring under test is AppContent → AuthenticatedApp → <page>; the pages
// themselves have their own suites.
const seenProps = {};
vi.mock('../components/DocList', () => ({
  default: (props) => { seenProps.docList = props; return <div data-testid="doclist" />; },
}));
vi.mock('../pages/SpaceSettingsPage', () => ({
  default: (props) => { seenProps.spacePage = props; return <div data-testid="space-page" />; },
}));
vi.mock('../components/EditorView', () => ({ default: () => <div data-testid="editor" /> }));
vi.mock('../components/AiPanel', () => ({ default: () => null }));
vi.mock('../pages/ChatPage', () => ({ default: () => null }));

import App from '../App';

// The global test setup replaces window.location with a plain object, so
// pushState never reflects there — set the pathname directly instead.
const mountAt = (path) => {
  window.location.pathname = path;
  return render(<App />);
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => '',
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('App full mount (authenticated views)', () => {
  it('renders the document list view and threads every navigate prop DocList uses', () => {
    mountAt('/docs');
    expect(screen.getByTestId('doclist')).toBeInTheDocument();
    // The 053 regression: this prop existed in the JSX but the identifier was
    // undefined in AuthenticatedApp's scope, crashing the page.
    expect(typeof seenProps.docList.onNavigateToSpace).toBe('function');
    expect(typeof seenProps.docList.onNavigate).toBe('function');
  });

  it('navigating via onNavigateToSpace renders the space settings view', () => {
    mountAt('/docs');
    const spaceId = 'b5384268-306a-48df-99b5-0d30bb747bc5';
    React.act(() => {
      seenProps.docList.onNavigateToSpace(spaceId);
    });
    expect(screen.getByTestId('space-page')).toBeInTheDocument();
    expect(seenProps.spacePage.spaceId).toBe(spaceId);
  });

  it('renders the space settings view from a direct /space/:id URL', () => {
    const spaceId = 'b5384268-306a-48df-99b5-0d30bb747bc5';
    mountAt(`/space/${spaceId}`);
    expect(screen.getByTestId('space-page')).toBeInTheDocument();
    expect(seenProps.spacePage.spaceId).toBe(spaceId);
  });
});
