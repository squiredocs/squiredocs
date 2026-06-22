import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { Plugin, NodeSelection } from '@tiptap/pm/state';
import ImageNodeView from '../components/ImageNodeView.jsx';
import { isImageType } from '../utils/media';
import { uploadDocumentImage } from '../utils/uploadImage';

// Block-level image node. Bytes live in S3; the node only holds a short app URL
// (/api/docs/:docId/images/:imageId) — the node view resolves it to a presigned
// URL at render time (see ImageNodeView). Mirrors the shared ProseMirror schema
// in shared/prosemirror-schema.js.

/**
 * Upload dropped/pasted image files and insert image nodes for them.
 * Returns true if it handled at least one image file (so the caller can
 * preventDefault), false otherwise.
 */
function handleImageFiles(view, fileList, pos, imageUpload) {
  if (!imageUpload || !imageUpload.docId || !imageUpload.api) return false;
  const files = Array.from(fileList).filter((f) => isImageType(f.type));
  if (files.length === 0) return false;

  files.forEach(async (file) => {
    try {
      const { url } = await uploadDocumentImage(imageUpload.api, imageUpload.docId, file);
      if (view.isDestroyed) return;
      const { state } = view;
      const node = state.schema.nodes.image.create({ src: url, alt: file.name });
      const at = Math.min(
        typeof pos === 'number' ? pos : state.selection.from,
        state.doc.content.size
      );
      view.dispatch(state.tr.insert(at, node));
    } catch (err) {
      console.error('Image upload failed:', err);
    }
  });
  return true;
}

export const ImageNode = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,

  addOptions() {
    // imageUpload: { docId, api } | null — present only in editable editors.
    return { imageUpload: null };
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      width: {
        default: null,
        parseHTML: (el) => (el.getAttribute('width') ? parseInt(el.getAttribute('width'), 10) : null),
        renderHTML: (attrs) => (attrs.width ? { width: attrs.width } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'img[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },

  addCommands() {
    return {
      setImage:
        (attrs) =>
        ({ chain }) =>
          chain().focus().insertContent({ type: this.name, attrs }).run(),
    };
  },

  addKeyboardShortcuts() {
    // When the image is node-selected, Backspace/Delete should remove it.
    // This takes precedence over the base keymap handlers (selectNodeBackward
    // /joinBackward) that otherwise leave an atom node in place.
    const deleteSelectedImage = () => {
      const { selection } = this.editor.state;
      if (selection instanceof NodeSelection && selection.node.type.name === this.name) {
        return this.editor.commands.deleteSelection();
      }
      return false;
    };
    return {
      Backspace: deleteSelectedImage,
      Delete: deleteSelectedImage,
    };
  },

  addProseMirrorPlugins() {
    const { imageUpload } = this.options;
    return [
      new Plugin({
        props: {
          handlePaste(view, event) {
            const files = event.clipboardData?.files;
            if (files && files.length && handleImageFiles(view, files, null, imageUpload)) {
              event.preventDefault();
              return true;
            }
            return false;
          },
          handleDrop(view, event) {
            const files = event.dataTransfer?.files;
            if (files && files.length) {
              const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
              const pos = coords ? coords.pos : null;
              if (handleImageFiles(view, files, pos, imageUpload)) {
                event.preventDefault();
                return true;
              }
            }
            return false;
          },
        },
      }),
    ];
  },
});

export default ImageNode;
