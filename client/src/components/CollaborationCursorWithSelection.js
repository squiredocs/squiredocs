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

        // Check if this is an AI agent
        const isAgent = user.isAgent === true;

        if (isAgent) {
          // Agent cursor with delegating user avatar overlay
          label.classList.add('agent-cursor');

          // Create avatar container
          const avatarContainer = document.createElement('div');
          avatarContainer.classList.add('agent-avatar-container');

          // Robot emoji as main avatar
          const robotAvatar = document.createElement('div');
          robotAvatar.classList.add('agent-robot-avatar');
          robotAvatar.textContent = '🤖';
          avatarContainer.appendChild(robotAvatar);

          // Delegating user's picture as overlay (if available)
          if (user.picture) {
            const userOverlay = document.createElement('img');
            userOverlay.src = user.picture;
            userOverlay.classList.add('agent-user-overlay');
            userOverlay.alt = '';
            avatarContainer.appendChild(userOverlay);
          }

          label.appendChild(avatarContainer);

          // Name label
          const nameText = document.createElement('span');
          nameText.textContent = user.name;
          label.appendChild(nameText);
        } else {
          // Regular user cursor
          label.textContent = user.name;
        }

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
