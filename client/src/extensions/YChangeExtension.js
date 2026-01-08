import { Mark, mergeAttributes } from '@tiptap/core';

/**
 * YChange Mark Extension
 *
 * This extension renders the `ychange` attribute that y-prosemirror adds
 * during snapshot diff visualization. It creates marks for text that was
 * added or removed between two versions.
 *
 * When y-prosemirror renders a snapshot diff, it calls:
 *   schema.mark('ychange', { type: 'added' }) or
 *   schema.mark('ychange', { type: 'removed' })
 *
 * This extension renders those marks as <span ychange="added"> or <span ychange="removed">
 * which can then be styled with CSS.
 */
export const YChangeMark = Mark.create({
  name: 'ychange',

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      type: {
        default: null,
      },
      user: {
        default: null,
      },
      color: {
        default: null,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[ychange]',
        getAttrs: element => ({
          type: element.getAttribute('ychange'),
        }),
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    // Get the type from attributes (will be 'added' or 'removed')
    const type = HTMLAttributes.type;

    if (!type) {
      return ['span', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
    }

    // Render as <span ychange="added"> or <span ychange="removed">
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, {
        ychange: type,
      }),
      0,
    ];
  },
});

export default YChangeMark;
