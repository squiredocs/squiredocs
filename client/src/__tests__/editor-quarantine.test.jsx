/**
 * Feature 021 — enableContentCheck quarantine second layer
 * (DR-1/Addition-4, research R5).
 *
 * A whole-doc schema mismatch (a doc using node types this bundle lacks)
 * must quarantine the editor — disable collaboration, freeze editing,
 * surface a refresh banner — and NEVER mutate the shared doc. Independent of
 * the binding-hardening kill-switch. Uses the established Editor.test.jsx
 * TipTap mock pattern to capture the useEditor options and drive
 * onContentError with a controlled event.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import Editor from '../components/Editor';
import { useAuth } from '../contexts/AuthContext';
import { createMockYjsProvider, createMockAuthContext } from '../test/utils';

vi.mock('../contexts/AuthContext');

const mockUseEditor = vi.fn();
vi.mock('@tiptap/react', () => ({
  useEditor: (...args) => mockUseEditor(...args),
  EditorContent: () => <div data-testid="editor-content">Editor Content</div>,
}));

vi.mock('../components/CollaborationCursorWithSelection', () => ({
  default: {
    configure: vi.fn((options) => ({ name: 'collaborationCursor', options })),
  },
}));

const mockIsMobile = vi.fn(() => false);
vi.mock('../hooks/useMobile', () => ({
  useMobile: () => mockIsMobile(),
}));

describe('021 quarantine second layer (enableContentCheck)', () => {
  let mockYdoc;
  let mockProvider;
  let mockAwareness;
  let mockEditor;
  let errorSpy;

  beforeEach(() => {
    const { doc, provider, awareness } = createMockYjsProvider();
    mockYdoc = doc;
    mockProvider = provider;
    mockAwareness = awareness;
    mockEditor = {
      extensionManager: { extensions: [] },
      chain: vi.fn(() => ({ focus: vi.fn(() => ({ run: vi.fn() })) })),
      isActive: vi.fn(() => false),
      setEditable: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
    mockUseEditor.mockReturnValue(mockEditor);
    vi.mocked(useAuth).mockReturnValue(createMockAuthContext());
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.clearAllMocks();
  });

  function renderEditor(props = {}) {
    return render(
      <Editor
        ydoc={mockYdoc}
        awareness={mockAwareness}
        provider={mockProvider}
        docId="doc-021"
        {...props}
      />
    );
  }

  it('enables TipTap content checking on every editor instance', () => {
    renderEditor();
    const options = mockUseEditor.mock.calls[0][0];
    expect(options.enableContentCheck).toBe(true);
    expect(typeof options.onContentError).toBe('function');
  });

  it('contentError => collaboration disabled, editor read-only, banner callback, no Y mutation', () => {
    const onQuarantine = vi.fn();
    renderEditor({ onQuarantine });
    const options = mockUseEditor.mock.calls[0][0];

    const before = Y.encodeStateAsUpdate(mockYdoc);
    const disableCollaboration = vi.fn();
    const failedEditor = { setEditable: vi.fn() };
    const error = new RangeError('Invalid content for node doc');

    options.onContentError({ editor: failedEditor, error, disableCollaboration });

    // Quarantine actions, in the documented order of intent:
    expect(disableCollaboration).toHaveBeenCalledTimes(1);
    expect(failedEditor.setEditable).toHaveBeenCalledWith(false);
    // Banner surfaced through the EditorView callback:
    expect(onQuarantine).toHaveBeenCalledTimes(1);
    expect(onQuarantine).toHaveBeenCalledWith(error);
    // The shared doc is untouched by quarantine:
    const after = Y.encodeStateAsUpdate(mockYdoc);
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
  });

  it('quarantine still completes when no onQuarantine callback is wired', () => {
    renderEditor(); // no callback
    const options = mockUseEditor.mock.calls[0][0];
    const disableCollaboration = vi.fn();
    const failedEditor = { setEditable: vi.fn() };

    expect(() =>
      options.onContentError({ editor: failedEditor, error: new Error('x'), disableCollaboration })
    ).not.toThrow();
    expect(disableCollaboration).toHaveBeenCalled();
    expect(failedEditor.setEditable).toHaveBeenCalledWith(false);
  });

  it('editor recreation carries the check (options rebuilt with the handler)', () => {
    const { rerender } = renderEditor();
    // Force the [isMobile, provider] recreation path.
    mockIsMobile.mockReturnValue(true);
    rerender(
      <Editor
        ydoc={mockYdoc}
        awareness={mockAwareness}
        provider={mockProvider}
        docId="doc-021"
      />
    );
    const lastOptions = mockUseEditor.mock.calls.at(-1)[0];
    expect(lastOptions.enableContentCheck).toBe(true);
    expect(typeof lastOptions.onContentError).toBe('function');
  });

  it('is independent of the binding-hardening kill-switch', () => {
    globalThis.__SQUIRE_COLLAB_HARDENING__ = false;
    try {
      const onQuarantine = vi.fn();
      renderEditor({ onQuarantine });
      const options = mockUseEditor.mock.calls[0][0];
      expect(options.enableContentCheck).toBe(true);
      const disableCollaboration = vi.fn();
      options.onContentError({
        editor: { setEditable: vi.fn() },
        error: new Error('mismatch'),
        disableCollaboration,
      });
      expect(disableCollaboration).toHaveBeenCalled();
      expect(onQuarantine).toHaveBeenCalled();
    } finally {
      delete globalThis.__SQUIRE_COLLAB_HARDENING__;
    }
  });
});
