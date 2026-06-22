import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Toolbar from '../Toolbar';
import { useAuth } from '../../contexts/AuthContext';
import { createMockEditor, createMockAuthContext } from '../../test/utils';

vi.mock('../../contexts/AuthContext');

describe('Toolbar', () => {
  let mockEditor;

  beforeEach(() => {
    mockEditor = createMockEditor();
    vi.mocked(useAuth).mockReturnValue(createMockAuthContext());
  });

  it('renders all formatting buttons', () => {
    render(<Toolbar editor={mockEditor} />);
    
    expect(screen.getByTitle('Bold')).toBeInTheDocument();
    expect(screen.getByTitle('Italic')).toBeInTheDocument();
    expect(screen.getByTitle('Underline')).toBeInTheDocument();
    expect(screen.getByTitle('Strikethrough')).toBeInTheDocument();
    expect(screen.getByTitle('Heading 1')).toBeInTheDocument();
    expect(screen.getByTitle('Heading 2')).toBeInTheDocument();
    expect(screen.getByTitle('Heading 3')).toBeInTheDocument();
    expect(screen.getByTitle('Heading 4')).toBeInTheDocument();
    expect(screen.getByTitle('Bullet List')).toBeInTheDocument();
    expect(screen.getByTitle('Numbered List')).toBeInTheDocument();
    expect(screen.getByTitle('Code')).toBeInTheDocument();
  });

  it('returns null when editor is not available', () => {
    const { container } = render(<Toolbar editor={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('calls editor methods when buttons are clicked', async () => {
    const user = userEvent.setup();
    render(<Toolbar editor={mockEditor} />);
    
    const boldButton = screen.getByTitle('Bold');
    await user.click(boldButton);
    
    expect(mockEditor.chain).toHaveBeenCalled();
  });

  it('applies active state to buttons', () => {
    mockEditor.isActive = vi.fn((name) => name === 'bold');
    
    render(<Toolbar editor={mockEditor} />);
    
    const boldButton = screen.getByTitle('Bold');
    expect(boldButton).toHaveClass('is-active');
    
    const italicButton = screen.getByTitle('Italic');
    expect(italicButton).not.toHaveClass('is-active');
  });

  it('handles all formatting actions', async () => {
    const user = userEvent.setup();
    render(<Toolbar editor={mockEditor} />);
    
    const buttons = [
      'Bold', 'Italic', 'Underline', 'Strikethrough',
      'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4',
      'Bullet List', 'Numbered List', 'Code'
    ];
    
    for (const buttonTitle of buttons) {
      const button = screen.getByTitle(buttonTitle);
      await user.click(button);
    }
    
    expect(mockEditor.chain).toHaveBeenCalledTimes(buttons.length);
  });
});

