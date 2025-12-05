import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CollaborationCursorWithSelection } from '../CollaborationCursorWithSelection';

// Mock y-prosemirror
vi.mock('y-prosemirror', () => ({
  yCursorPlugin: vi.fn((awareness, options) => ({
    key: 'yCursorPlugin',
    awareness,
    options,
  })),
}));

describe('CollaborationCursorWithSelection', () => {
  let mockAwareness;
  let mockProvider;

  beforeEach(() => {
    mockAwareness = {
      setLocalStateField: vi.fn(),
      getStates: () => new Map(),
      on: vi.fn(),
      off: vi.fn(),
    };
    
    mockProvider = {
      awareness: mockAwareness,
    };
    
    // Reset DOM for color conversion tests
    document.body.innerHTML = '';
  });

  describe('extension configuration', () => {
    it('has correct name', () => {
      expect(CollaborationCursorWithSelection.name).toBe('collaborationCursor');
    });

    it('has default options', () => {
      const extension = CollaborationCursorWithSelection.configure({});
      const options = extension.options;
      
      expect(options.provider).toBeNull();
      expect(options.user).toEqual({ name: null, color: null });
      expect(typeof options.render).toBe('function');
      expect(typeof options.selectionRender).toBe('function');
    });

    it('accepts custom provider and user', () => {
      const user = { name: 'Test', color: '#ff0000' };
      const extension = CollaborationCursorWithSelection.configure({
        provider: mockProvider,
        user,
      });
      
      expect(extension.options.provider).toBe(mockProvider);
      expect(extension.options.user).toStrictEqual(user);
    });
  });

  describe('default render function', () => {
    it('creates cursor element with label', () => {
      const extension = CollaborationCursorWithSelection.configure({});
      const user = { name: 'Alice', color: '#ff0000' };
      
      const cursor = extension.options.render(user);
      
      expect(cursor.tagName).toBe('SPAN');
      expect(cursor.classList.contains('collaboration-cursor__caret')).toBe(true);
      expect(cursor.style.borderColor).toBe('rgb(255, 0, 0)');
      
      const label = cursor.querySelector('.collaboration-cursor__label');
      expect(label).not.toBeNull();
      expect(label.textContent).toBe('Alice');
      expect(label.style.backgroundColor).toBe('rgb(255, 0, 0)');
    });
  });

  describe('default selectionRender function', () => {
    it('returns decoration attributes object with hex color', () => {
      const extension = CollaborationCursorWithSelection.configure({});
      const user = { name: 'Bob', color: '#00ff00' };
      
      const attrs = extension.options.selectionRender(user);
      
      expect(attrs).toHaveProperty('style');
      expect(attrs).toHaveProperty('class', 'collaboration-cursor__selection');
      expect(attrs.style).toContain('background-color:');
      expect(attrs.style).toContain('rgba(0, 255, 0, 0.3)');
    });

    it('handles rgb color format', () => {
      const extension = CollaborationCursorWithSelection.configure({});
      const user = { name: 'Carol', color: 'rgb(100, 150, 200)' };
      
      const attrs = extension.options.selectionRender(user);
      
      expect(attrs.style).toContain('rgba(100, 150, 200, 0.3)');
    });
  });

  describe('ProseMirror plugins', () => {
    it('returns empty array when no provider', () => {
      const extension = CollaborationCursorWithSelection.configure({
        provider: null,
      });
      
      // Create a mock editor storage context
      const mockStorage = {};
      const context = { 
        options: extension.options,
        storage: mockStorage,
      };
      
      const plugins = CollaborationCursorWithSelection.config.addProseMirrorPlugins.call(context);
      
      expect(plugins).toEqual([]);
    });

    it('creates yCursorPlugin with correct options when provider exists', async () => {
      const { yCursorPlugin } = await import('y-prosemirror');
      
      const customRender = vi.fn();
      const customSelectionRender = vi.fn();
      const user = { name: 'Dave', color: '#0000ff' };
      
      const extension = CollaborationCursorWithSelection.configure({
        provider: mockProvider,
        user,
        render: customRender,
        selectionRender: customSelectionRender,
      });
      
      const context = { options: extension.options };
      const plugins = CollaborationCursorWithSelection.config.addProseMirrorPlugins.call(context);
      
      expect(plugins).toHaveLength(1);
      expect(yCursorPlugin).toHaveBeenCalledWith(
        mockAwareness,
        {
          cursorBuilder: customRender,
          selectionBuilder: customSelectionRender,
        }
      );
    });

    it('sets local user state on awareness', async () => {
      const user = { name: 'Eve', color: '#purple' };
      
      const extension = CollaborationCursorWithSelection.configure({
        provider: mockProvider,
        user,
      });
      
      const context = { options: extension.options };
      CollaborationCursorWithSelection.config.addProseMirrorPlugins.call(context);
      
      expect(mockAwareness.setLocalStateField).toHaveBeenCalledWith('user', user);
    });
  });
});
