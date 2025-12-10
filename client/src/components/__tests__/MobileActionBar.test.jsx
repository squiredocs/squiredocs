import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import MobileActionBar from '../MobileActionBar';

// Mock y-prosemirror with configurable state
const mockUndoManager = {
  undoStack: [],
  redoStack: [],
};

vi.mock('y-prosemirror', () => ({
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
        })),
      })),
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

  it('renders all action buttons when editor is ready', () => {
    render(<MobileActionBar editor={mockEditor} />);

    expect(screen.getByTitle('Undo')).toBeInTheDocument();
    expect(screen.getByTitle('Redo')).toBeInTheDocument();
    expect(screen.getByTitle('Decrease indent')).toBeInTheDocument();
    expect(screen.getByTitle('Increase indent')).toBeInTheDocument();
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

  it('disables indent buttons when commands cannot be executed', () => {
    // Default mock has can() returning false for both
    mockEditor.can = vi.fn(() => ({
      sinkListItem: vi.fn(() => false),
      liftListItem: vi.fn(() => false),
    }));

    render(<MobileActionBar editor={mockEditor} />);

    expect(screen.getByTitle('Increase indent')).toBeDisabled();
    expect(screen.getByTitle('Decrease indent')).toBeDisabled();
  });

  it('enables indent button only when sinkListItem can be executed', async () => {
    mockEditor.can = vi.fn(() => ({
      sinkListItem: vi.fn(() => true),
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

  it('has proper accessibility labels', () => {
    render(<MobileActionBar editor={mockEditor} />);

    expect(screen.getByLabelText('Undo')).toBeInTheDocument();
    expect(screen.getByLabelText('Redo')).toBeInTheDocument();
    expect(screen.getByLabelText('Increase indent')).toBeInTheDocument();
    expect(screen.getByLabelText('Decrease indent')).toBeInTheDocument();
  });
});
