import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MobileActionBar from '../MobileActionBar';

// Mock @tiptap/y-tiptap with configurable state
const mockUndoManager = {
  undoStack: [],
  redoStack: [],
};

vi.mock('@tiptap/y-tiptap', () => ({
  yUndoPluginKey: {
    getState: vi.fn(() => ({
      undoManager: mockUndoManager,
    })),
  },
}));

describe('MobileActionBar', () => {
  let mockEditor;

  beforeEach(() => {
    mockEditor = {
      state: {},
      commands: {
        undo: vi.fn(() => true),
        redo: vi.fn(() => true),
      },
      chain: vi.fn(() => ({
        focus: vi.fn(() => ({
          sinkListItem: vi.fn(() => ({ run: vi.fn() })),
          liftListItem: vi.fn(() => ({ run: vi.fn() })),
          toggleBold: vi.fn(() => ({ run: vi.fn() })),
          toggleItalic: vi.fn(() => ({ run: vi.fn() })),
          toggleUnderline: vi.fn(() => ({ run: vi.fn() })),
          toggleStrike: vi.fn(() => ({ run: vi.fn() })),
          toggleSubscript: vi.fn(() => ({ run: vi.fn() })),
          toggleSuperscript: vi.fn(() => ({ run: vi.fn() })),
          toggleHeading: vi.fn(() => ({ run: vi.fn() })),
          toggleBlockquote: vi.fn(() => ({ run: vi.fn() })),
          toggleBulletList: vi.fn(() => ({ run: vi.fn() })),
          toggleOrderedList: vi.fn(() => ({ run: vi.fn() })),
          toggleCode: vi.fn(() => ({ run: vi.fn() })),
          extendMarkRange: vi.fn(() => ({
            setLink: vi.fn(() => ({ run: vi.fn() })),
            unsetLink: vi.fn(() => ({ run: vi.fn() })),
          })),
          unsetAllMarks: vi.fn(() => ({ run: vi.fn() })),
        })),
      })),
      getAttributes: vi.fn(() => ({ href: '' })),
      can: vi.fn(() => ({
        sinkListItem: vi.fn(() => false),
        liftListItem: vi.fn(() => false),
      })),
      isActive: vi.fn(() => false),
      on: vi.fn(),
      off: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Reset mock undo manager state
    mockUndoManager.undoStack = [];
    mockUndoManager.redoStack = [];
  });

  it('renders nothing when editor is not ready', () => {
    const { container } = render(<MobileActionBar editor={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders undo/redo buttons always', () => {
    render(<MobileActionBar editor={mockEditor} />);

    expect(screen.getByTitle('Undo')).toBeInTheDocument();
    expect(screen.getByTitle('Redo')).toBeInTheDocument();
  });

  it('does not render indent/outdent buttons when not in list context', () => {
    mockEditor.can = vi.fn(() => ({
      sinkListItem: vi.fn(() => false),
      liftListItem: vi.fn(() => false),
    }));

    render(<MobileActionBar editor={mockEditor} />);

    expect(screen.queryByTitle('Decrease indent')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Increase indent')).not.toBeInTheDocument();
  });

  it('renders indent/outdent buttons when in list context', () => {
    mockEditor.can = vi.fn(() => ({
      sinkListItem: vi.fn(() => true),
      liftListItem: vi.fn(() => false),
    }));

    render(<MobileActionBar editor={mockEditor} />);

    expect(screen.getByTitle('Decrease indent')).toBeInTheDocument();
    expect(screen.getByTitle('Increase indent')).toBeInTheDocument();
  });

  it('renders format buttons always', () => {
    render(<MobileActionBar editor={mockEditor} />);

    // Text formatting
    expect(screen.getByTitle('Bold')).toBeInTheDocument();
    expect(screen.getByTitle('Italic')).toBeInTheDocument();
    expect(screen.getByTitle('Underline')).toBeInTheDocument();
    expect(screen.getByTitle('Strikethrough')).toBeInTheDocument();
    expect(screen.getByTitle('Subscript')).toBeInTheDocument();
    expect(screen.getByTitle('Superscript')).toBeInTheDocument();
    expect(screen.getByTitle('Clear formatting')).toBeInTheDocument();
    // Headings
    expect(screen.getByTitle('Heading 1')).toBeInTheDocument();
    expect(screen.getByTitle('Heading 2')).toBeInTheDocument();
    expect(screen.getByTitle('Heading 3')).toBeInTheDocument();
    // Block elements and lists
    expect(screen.getByTitle('Blockquote')).toBeInTheDocument();
    expect(screen.getByTitle('Bullet List')).toBeInTheDocument();
    expect(screen.getByTitle('Numbered List')).toBeInTheDocument();
    expect(screen.getByTitle('Code')).toBeInTheDocument();
    expect(screen.getByTitle('Link')).toBeInTheDocument();
  });

  it('calls editor.commands.undo when undo button is clicked and has undo history', () => {
    // Set up undo stack so the button is enabled
    mockUndoManager.undoStack = [{}];

    render(<MobileActionBar editor={mockEditor} />);

    const undoButton = screen.getByTitle('Undo');
    expect(undoButton).not.toBeDisabled();
    fireEvent.click(undoButton);
    expect(mockEditor.commands.undo).toHaveBeenCalled();
  });

  it('calls editor.commands.redo when redo button is clicked and has redo history', () => {
    // Set up redo stack so the button is enabled
    mockUndoManager.redoStack = [{}];

    render(<MobileActionBar editor={mockEditor} />);

    const redoButton = screen.getByTitle('Redo');
    expect(redoButton).not.toBeDisabled();
    fireEvent.click(redoButton);
    expect(mockEditor.commands.redo).toHaveBeenCalled();
  });

  it('calls sinkListItem when indent button is clicked and can indent', () => {
    const mockRun = vi.fn();
    const mockSinkListItem = vi.fn(() => ({ run: mockRun }));
    mockEditor.chain = vi.fn(() => ({
      focus: vi.fn(() => ({
        sinkListItem: mockSinkListItem,
        liftListItem: vi.fn(() => ({ run: vi.fn() })),
      })),
    }));
    // Enable indent button by making can().sinkListItem return true
    mockEditor.can = vi.fn(() => ({
      sinkListItem: vi.fn(() => true),
      liftListItem: vi.fn(() => false),
    }));

    render(<MobileActionBar editor={mockEditor} />);

    const indentButton = screen.getByTitle('Increase indent');
    expect(indentButton).not.toBeDisabled();
    fireEvent.click(indentButton);
    expect(mockSinkListItem).toHaveBeenCalledWith('listItem');
    expect(mockRun).toHaveBeenCalled();
  });

  it('calls liftListItem when outdent button is clicked and can outdent', () => {
    const mockRun = vi.fn();
    const mockLiftListItem = vi.fn(() => ({ run: mockRun }));
    mockEditor.chain = vi.fn(() => ({
      focus: vi.fn(() => ({
        sinkListItem: vi.fn(() => ({ run: vi.fn() })),
        liftListItem: mockLiftListItem,
      })),
    }));
    // Enable outdent button by making can().liftListItem return true
    mockEditor.can = vi.fn(() => ({
      sinkListItem: vi.fn(() => false),
      liftListItem: vi.fn(() => true),
    }));

    render(<MobileActionBar editor={mockEditor} />);

    const outdentButton = screen.getByTitle('Decrease indent');
    expect(outdentButton).not.toBeDisabled();
    fireEvent.click(outdentButton);
    expect(mockLiftListItem).toHaveBeenCalledWith('listItem');
    expect(mockRun).toHaveBeenCalled();
  });

  it('disables indent button when sinkListItem cannot be executed', () => {
    // Show buttons but disable indent
    mockEditor.can = vi.fn(() => ({
      sinkListItem: vi.fn(() => false),
      liftListItem: vi.fn(() => true), // Show buttons since in list context
    }));

    render(<MobileActionBar editor={mockEditor} />);

    expect(screen.getByTitle('Increase indent')).toBeDisabled();
    expect(screen.getByTitle('Decrease indent')).not.toBeDisabled();
  });

  it('disables outdent button when liftListItem cannot be executed', () => {
    // Show buttons but disable outdent
    mockEditor.can = vi.fn(() => ({
      sinkListItem: vi.fn(() => true), // Show buttons since in list context
      liftListItem: vi.fn(() => false),
    }));

    render(<MobileActionBar editor={mockEditor} />);

    expect(screen.getByTitle('Increase indent')).not.toBeDisabled();
    expect(screen.getByTitle('Decrease indent')).toBeDisabled();
  });

  it('subscribes to editor events on mount', () => {
    render(<MobileActionBar editor={mockEditor} />);

    expect(mockEditor.on).toHaveBeenCalledWith('selectionUpdate', expect.any(Function));
    expect(mockEditor.on).toHaveBeenCalledWith('transaction', expect.any(Function));
  });

  it('unsubscribes from editor events on unmount', () => {
    const { unmount } = render(<MobileActionBar editor={mockEditor} />);

    unmount();

    expect(mockEditor.off).toHaveBeenCalledWith('selectionUpdate', expect.any(Function));
    expect(mockEditor.off).toHaveBeenCalledWith('transaction', expect.any(Function));
  });

  it('has proper accessibility labels for action buttons', () => {
    render(<MobileActionBar editor={mockEditor} />);

    expect(screen.getByLabelText('Undo')).toBeInTheDocument();
    expect(screen.getByLabelText('Redo')).toBeInTheDocument();
  });

  it('has proper accessibility labels for indent buttons when in list context', () => {
    mockEditor.can = vi.fn(() => ({
      sinkListItem: vi.fn(() => true),
      liftListItem: vi.fn(() => true),
    }));

    render(<MobileActionBar editor={mockEditor} />);

    expect(screen.getByLabelText('Increase indent')).toBeInTheDocument();
    expect(screen.getByLabelText('Decrease indent')).toBeInTheDocument();
  });

  it('has proper accessibility labels for format buttons', () => {
    render(<MobileActionBar editor={mockEditor} />);

    // Text formatting
    expect(screen.getByLabelText('Bold')).toBeInTheDocument();
    expect(screen.getByLabelText('Italic')).toBeInTheDocument();
    expect(screen.getByLabelText('Underline')).toBeInTheDocument();
    expect(screen.getByLabelText('Strikethrough')).toBeInTheDocument();
    expect(screen.getByLabelText('Subscript')).toBeInTheDocument();
    expect(screen.getByLabelText('Superscript')).toBeInTheDocument();
    expect(screen.getByLabelText('Clear formatting')).toBeInTheDocument();
    // Headings
    expect(screen.getByLabelText('Heading 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Heading 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Heading 3')).toBeInTheDocument();
    // Block elements and lists
    expect(screen.getByLabelText('Blockquote')).toBeInTheDocument();
    expect(screen.getByLabelText('Bullet List')).toBeInTheDocument();
    expect(screen.getByLabelText('Numbered List')).toBeInTheDocument();
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
    expect(screen.getByLabelText('Link')).toBeInTheDocument();
  });

  it('applies active class to format buttons based on editor state', () => {
    mockEditor.isActive = vi.fn((type) => type === 'bold');

    render(<MobileActionBar editor={mockEditor} />);

    const boldButton = screen.getByTitle('Bold');
    expect(boldButton).toHaveClass('is-active');

    const italicButton = screen.getByTitle('Italic');
    expect(italicButton).not.toHaveClass('is-active');
  });

  it('prevents focus loss on mousedown and touchstart', () => {
    render(<MobileActionBar editor={mockEditor} />);

    const container = screen.getByTitle('Undo').closest('.mobile-action-bar');

    const mouseDownEvent = new MouseEvent('mousedown', { bubbles: true });
    Object.defineProperty(mouseDownEvent, 'preventDefault', { value: vi.fn() });
    fireEvent(container, mouseDownEvent);
    expect(mouseDownEvent.preventDefault).toHaveBeenCalled();

    const touchStartEvent = new Event('touchstart', { bubbles: true });
    Object.defineProperty(touchStartEvent, 'preventDefault', { value: vi.fn() });
    fireEvent(container, touchStartEvent);
    expect(touchStartEvent.preventDefault).toHaveBeenCalled();
  });
});
