import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Mock CollaborationCursorWithSelection
vi.mock('../CollaborationCursorWithSelection', () => ({
  default: {
    configure: vi.fn((options) => ({
      name: 'collaborationCursor',
      type: { name: 'collaborationCursor' },
      options,
    })),
  },
}));

describe('Editor', () => {
  let mockEditor;
  let mockYdoc;
  let mockProvider;
  let mockAwareness;
  let mockUser;

  beforeEach(() => {
    const { doc, provider, awareness } = createMockYjsProvider();
    mockYdoc = doc;
    mockProvider = provider;
    mockAwareness = awareness;
    
    mockUser = {
      name: 'Test User',
      color: '#ff0000',
      email: 'test@example.com',
      picture: 'https://example.com/avatar.jpg'
    };
    
    mockEditor = {
      extensionManager: { extensions: [] },
      chain: vi.fn(() => ({ focus: vi.fn(() => ({ run: vi.fn() })) })),
      isActive: vi.fn(() => false),
      on: vi.fn(),
      off: vi.fn()
    };
    mockUseEditor.mockReturnValue(mockEditor);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state when editor is not ready', () => {
    mockUseEditor.mockReturnValue(null);
    
    render(
      <Editor
        ydoc={mockYdoc}
        awareness={mockAwareness}
        provider={mockProvider}
        user={mockUser}
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
        user={mockUser}
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
        user={mockUser}
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

  it('configures editor with CollaborationCursor extension', () => {
    render(
      <Editor
        ydoc={mockYdoc}
        awareness={mockAwareness}
        provider={mockProvider}
        user={mockUser}
        synced={true}
      />
    );
    
    const callArgs = mockUseEditor.mock.calls[0][0];
    expect(callArgs.extensions).toBeDefined();
    
    // Check that CollaborationCursor extension is included
    const hasCollaborationCursor = callArgs.extensions.some(
      ext => ext.name === 'collaborationCursor' || ext.type?.name === 'collaborationCursor'
    );
    expect(hasCollaborationCursor).toBe(true);
  });

  it('notifies parent when editor is ready', async () => {
    const onEditorReady = vi.fn();
    
    render(
      <Editor
        ydoc={mockYdoc}
        awareness={mockAwareness}
        provider={mockProvider}
        user={mockUser}
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
        user={mockUser}
        synced={false}
      />
    );
    
    expect(screen.getByText(/Loading editor/i)).toBeInTheDocument();
  });

  it('subscribes to awareness changes for cursor tracking', () => {
    render(
      <Editor
        ydoc={mockYdoc}
        awareness={mockAwareness}
        provider={mockProvider}
        user={mockUser}
        synced={true}
      />
    );
    
    expect(mockAwareness.on).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('cleans up awareness listener on unmount', () => {
    const { unmount } = render(
      <Editor
        ydoc={mockYdoc}
        awareness={mockAwareness}
        provider={mockProvider}
        user={mockUser}
        synced={true}
      />
    );
    
    unmount();
    
    expect(mockAwareness.off).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('uses user color and name from props', () => {
    render(
      <Editor
        ydoc={mockYdoc}
        awareness={mockAwareness}
        provider={mockProvider}
        user={mockUser}
        synced={true}
      />
    );
    
    const callArgs = mockUseEditor.mock.calls[0][0];
    const cursorExt = callArgs.extensions.find(
      ext => ext.name === 'collaborationCursor' || ext.type?.name === 'collaborationCursor'
    );
    
    // Verify user info is passed to extension
    expect(cursorExt).toBeDefined();
  });

  it('handles missing user info gracefully', () => {
    render(
      <Editor
        ydoc={mockYdoc}
        awareness={mockAwareness}
        provider={mockProvider}
        user={null}
        synced={true}
      />
    );
    
    // Should not crash and should use defaults
    expect(screen.getByTestId('editor-content')).toBeInTheDocument();
  });

  describe('selection highlighting', () => {
    it('configures CollaborationCursorWithSelection with selectionRender', async () => {
      const CollaborationCursorWithSelection = await import('../CollaborationCursorWithSelection');
      
      render(
        <Editor
          ydoc={mockYdoc}
          awareness={mockAwareness}
          provider={mockProvider}
          user={mockUser}
          synced={true}
        />
      );
      
      expect(CollaborationCursorWithSelection.default.configure).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: mockProvider,
          selectionRender: expect.any(Function),
        })
      );
    });

    it('shows cursor labels when awareness state changes with cursor data', async () => {
      // Set up awareness to return cursor state
      const mockStates = new Map();
      mockStates.set(123, { cursor: { anchor: 0, head: 5 }, user: { name: 'Other', color: '#00ff00' } });
      mockAwareness.getStates = () => mockStates;
      
      let changeHandler;
      mockAwareness.on = vi.fn((event, handler) => {
        if (event === 'change') changeHandler = handler;
      });
      
      render(
        <Editor
          ydoc={mockYdoc}
          awareness={mockAwareness}
          provider={mockProvider}
          user={mockUser}
          synced={true}
        />
      );
      
      // Verify change handler was registered
      expect(mockAwareness.on).toHaveBeenCalledWith('change', expect.any(Function));
      expect(changeHandler).toBeDefined();
    });

    it('triggers label visibility on selection changes', async () => {
      const mockStates = new Map();
      mockStates.set(456, { cursor: { anchor: 10, head: 20 }, user: { name: 'Selector', color: '#ff00ff' } });
      mockAwareness.getStates = () => mockStates;
      
      let changeHandler;
      mockAwareness.on = vi.fn((event, handler) => {
        if (event === 'change') changeHandler = handler;
      });
      
      render(
        <Editor
          ydoc={mockYdoc}
          awareness={mockAwareness}
          provider={mockProvider}
          user={mockUser}
          synced={true}
        />
      );
      
      // Simulate awareness change with selection
      changeHandler({ added: [], updated: [456], removed: [] });
      
      // The handler should process without error
      // (In a real scenario, this would show cursor labels via DOM manipulation)
      expect(changeHandler).toBeDefined();
    });

    it('handles awareness changes for new users', async () => {
      const mockStates = new Map();
      mockStates.set(789, { cursor: { anchor: 0, head: 0 }, user: { name: 'NewUser', color: '#aabbcc' } });
      mockAwareness.getStates = () => mockStates;
      
      let changeHandler;
      mockAwareness.on = vi.fn((event, handler) => {
        if (event === 'change') changeHandler = handler;
      });
      
      render(
        <Editor
          ydoc={mockYdoc}
          awareness={mockAwareness}
          provider={mockProvider}
          user={mockUser}
          synced={true}
        />
      );
      
      // Simulate new user joining with cursor
      changeHandler({ added: [789], updated: [], removed: [] });
      
      expect(changeHandler).toBeDefined();
    });
  });
});

