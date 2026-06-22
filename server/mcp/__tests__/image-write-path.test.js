/**
 * Image write-path coverage: structured node building, the appendBlocks helper,
 * and the agent src guardrail.
 */
const Y = require('yjs');
const { buildYjsNode } = require('../yjs/node-builder');
const { appendBlocks } = require('../sandbox/helpers');
const { sanitizeImageSrcs, isAllowedImageSrc } = require('../image-validate');
const documentImages = require('../../document-images');
const { toMarkdown, toStructured } = require('../yjs/serialization');

function freshFragment() {
  const ydoc = new Y.Doc();
  return ydoc.get('default', Y.XmlFragment);
}

describe('buildYjsNode image', () => {
  it('carries src/alt/title/width attributes', () => {
    const frag = freshFragment();
    frag.insert(0, [buildYjsNode({ type: 'image', src: '/api/docs/d/images/i', alt: 'cat', title: 't', width: 300 })]);
    const node = frag.toArray()[0];
    expect(node.nodeName).toBe('image');
    expect(node.getAttribute('src')).toBe('/api/docs/d/images/i');
    expect(node.getAttribute('alt')).toBe('cat');
    expect(node.getAttribute('title')).toBe('t');
    expect(node.getAttribute('width')).toBe(300);
    expect(toStructured(frag)).toEqual([{ type: 'image', src: '/api/docs/d/images/i', alt: 'cat', title: 't', width: 300 }]);
    expect(toMarkdown(frag)).toBe('![cat](/api/docs/d/images/i)');
  });
});

describe('appendBlocks image', () => {
  it('appends an image block', () => {
    const frag = freshFragment();
    appendBlocks(frag, [{ type: 'image', src: '/api/docs/d/images/i', alt: 'x' }]);
    const node = frag.toArray()[0];
    expect(node.nodeName).toBe('image');
    expect(node.getAttribute('src')).toBe('/api/docs/d/images/i');
  });

  it('throws when src is missing', () => {
    const frag = freshFragment();
    expect(() => appendBlocks(frag, [{ type: 'image', alt: 'x' }])).toThrow(/image requires a src/);
  });
});

describe('sanitizeImageSrcs guardrail', () => {
  it('accepts only app image URLs', () => {
    expect(isAllowedImageSrc('/api/docs/d/images/i')).toBe(true);
    expect(isAllowedImageSrc('https://evil.com/track.png')).toBe(false);
    expect(isAllowedImageSrc('data:image/png;base64,AAAA')).toBe(false);
    expect(isAllowedImageSrc(null)).toBe(false);
  });

  it('removes images with a disallowed src and keeps valid ones', () => {
    const frag = freshFragment();
    const good = new Y.XmlElement('image'); good.setAttribute('src', '/api/docs/d/images/good');
    const ext = new Y.XmlElement('image'); ext.setAttribute('src', 'https://evil.com/track.png');
    const data = new Y.XmlElement('image'); data.setAttribute('src', 'data:image/png;base64,AAAA');
    const para = new Y.XmlElement('paragraph'); para.insert(0, [new Y.XmlText()]);
    frag.insert(0, [good, ext, data, para]);

    const removed = sanitizeImageSrcs(frag);
    expect(removed).toEqual([{ src: 'https://evil.com/track.png' }, { src: 'data:image/png;base64,AAAA' }]);
    const images = frag.toArray().filter((n) => n.nodeName === 'image');
    expect(images.map((n) => n.getAttribute('src'))).toEqual(['/api/docs/d/images/good']);
  });
});

describe('storeImage validation', () => {
  // These reject before any S3/DB call, so no infra is needed.
  const base = { docId: 'd', uploaderId: 'u' };

  it('rejects an unsupported mime type with status 400', async () => {
    await expect(documentImages.storeImage({ ...base, data: Buffer.from('x'), mimeType: 'image/svg+xml' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects empty data with status 400', async () => {
    await expect(documentImages.storeImage({ ...base, data: Buffer.alloc(0), mimeType: 'image/png' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects oversized data with status 413', async () => {
    const big = Buffer.alloc(documentImages.MAX_IMAGE_BYTES + 1);
    await expect(documentImages.storeImage({ ...base, data: big, mimeType: 'image/png' }))
      .rejects.toMatchObject({ status: 413 });
  });
});
