import { Extension } from '@tiptap/core';
import { yCursorPlugin } from '@tiptap/y-tiptap';
import { colorToRgba } from '../utils/colorUtils';

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
        const bgColor = colorToRgba(user.color, 0.3);
        return {
          style: `background-color: ${bgColor};`,
          class: 'collaboration-cursor__selection',
        };
      },
    };
  },

  addProseMirrorPlugins() {
    const { provider, render, selectionRender } = this.options;

    if (!provider) {
      return [];
    }

    const awareness = provider.awareness;

    // Note: Awareness user state is set by Editor component's useEffect
    // This ensures it updates properly when user info loads asynchronously

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
