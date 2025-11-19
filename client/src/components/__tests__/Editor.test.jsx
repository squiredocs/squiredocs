import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import * as Y from 'yjs';
import Editor from '../Editor';
import { createMockYjsProvider } from '../../test/utils';

// Mock TipTap
const mockUseEditor = vi.fn();
vi.mock('@tiptap/react', () => ({
  useEditor: (...args) => mockUseEditor(...args),
  EditorContent: ({ editor }) => <div data-testid="editor-content">Editor Content</div>
}));

describe('Editor', () => {
  let mockEditor;
  let mockYdoc;
  let mockProvider;
  let mockAwareness;

  beforeEach(() => {
    const { doc, provider, awareness } = createMockYjsProvider();
    mockYdoc = doc;
    mockProvider = provider;
    mockAwareness = awareness;
    
    mockEditor = {
      extensionManager: { extensions: [] },
      chain: vi.fn(() => ({ focus: vi.fn(() => ({ run: vi.fn() })) })),
      isActive: vi.fn(() => false)
    };
    mockUseEditor.mockReturnValue(mockEditor);
  });

  it('renders loading state when editor is not ready', () => {
    mockUseEditor.mockReturnValue(null);
    
    render(
      <Editor
        ydoc={mockYdoc}
        awareness={mockAwareness}
        provider={mockProvider}
        userName="Test User"
        userColor="#000000"
        synced={true}
      />
    );
    
    expect(screen.getByText(/Loading editor/i)).toBeInTheDocument();
  });

  it('renders editor when ready', () => {
    render(
      <Editor
        ydoc={mockYdoc}
        awareness={mockAwareness}
        provider={mockProvider}
        userName="Test User"
        userColor="#000000"
        synced={true}
      />
    );
    
    expect(screen.getByTestId('editor-content')).toBeInTheDocument();
  });

  it('configures editor with Collaboration extension', () => {
    render(
      <Editor
        ydoc={mockYdoc}
        awareness={mockAwareness}
        provider={mockProvider}
        userName="Test User"
        userColor="#000000"
        synced={true}
      />
    );
    
    const callArgs = mockUseEditor.mock.calls[0][0];
    expect(callArgs.extensions).toBeDefined();
    
    // Check that Collaboration extension is included
    const hasCollaboration = callArgs.extensions.some(
      ext => ext.name === 'collaboration' || ext.type?.name === 'collaboration'
    );
    expect(hasCollaboration).toBe(true);
  });

  it('notifies parent when editor is ready', async () => {
    const onEditorReady = vi.fn();
    
    render(
      <Editor
        ydoc={mockYdoc}
        awareness={mockAwareness}
        provider={mockProvider}
        userName="Test User"
        userColor="#000000"
        synced={true}
        onEditorReady={onEditorReady}
      />
    );
    
    await waitFor(() => {
      expect(onEditorReady).toHaveBeenCalledWith(mockEditor);
    });
  });

  it('handles missing ydoc gracefully', () => {
    render(
      <Editor
        ydoc={null}
        awareness={mockAwareness}
        provider={mockProvider}
        userName="Test User"
        userColor="#000000"
        synced={false}
      />
    );
    
    expect(screen.getByText(/Loading editor/i)).toBeInTheDocument();
  });
});

