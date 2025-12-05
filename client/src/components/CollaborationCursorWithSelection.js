import { Extension } from '@tiptap/core';
import { yCursorPlugin } from 'y-prosemirror';

/**
 * Custom CollaborationCursor extension that supports selection rendering.
 * TipTap v2's built-in CollaborationCursor doesn't expose the selectionBuilder option,
 * so we create our own extension that wraps y-prosemirror's yCursorPlugin directly.
 */
export const CollaborationCursorWithSelection = Extension.create({
  name: 'collaborationCursor',

  addOptions() {
    return {
      provider: null,
      user: {
        name: null,
        color: null,
      },
      render: (user) => {
        const cursor = document.createElement('span');
        cursor.classList.add('collaboration-cursor__caret');
        cursor.style.borderColor = user.color;

        const label = document.createElement('div');
        label.classList.add('collaboration-cursor__label');
        label.style.backgroundColor = user.color;
        label.textContent = user.name;
        cursor.appendChild(label);

        return cursor;
      },
      selectionRender: (user) => {
        // Return decoration attributes object, NOT a DOM element
        // Parse color and convert to rgba
        const temp = document.createElement('div');
        temp.style.color = user.color;
        document.body.appendChild(temp);
        const computed = getComputedStyle(temp).color;
        document.body.removeChild(temp);
        const match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        const bgColor = match 
          ? `rgba(${match[1]}, ${match[2]}, ${match[3]}, 0.3)`
          : 'rgba(0, 0, 0, 0.3)';
        return {
          style: `background-color: ${bgColor};`,
          class: 'collaboration-cursor__selection',
        };
      },
    };
  },

  addProseMirrorPlugins() {
    const { provider, user, render, selectionRender } = this.options;
    
    if (!provider) {
      return [];
    }

    const awareness = provider.awareness;

    // Set the local user state
    awareness.setLocalStateField('user', user);

    return [
      yCursorPlugin(
        awareness,
        {
          cursorBuilder: render,
          selectionBuilder: selectionRender,
        }
      ),
    ];
  },
});

export default CollaborationCursorWithSelection;
