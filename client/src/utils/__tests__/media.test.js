import { describe, it, expect, afterEach, vi } from 'vitest';
import { downscaleOversizedImage, MAX_IMAGE_DIMENSION } from '../media';

// jsdom has no createImageBitmap and no real canvas encoder, so the browser
// pieces are stubbed per test. The interesting logic is the decision-making:
// when to resize, target dimensions, output type, and that every failure mode
// degrades to null (= attach the original file unchanged).

const fakeFile = (type = 'image/png') => ({ type, name: 'x' });

function stubBitmap(width, height) {
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close })));
  return { close };
}

function stubCanvas() {
  const ctx = { drawImage: vi.fn() };
  const canvas = {
    getContext: () => ctx,
    toDataURL: vi.fn((mediaType) => `data:${mediaType};base64,AAAA`),
  };
  const orig = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(
    (tag) => (tag === 'canvas' ? canvas : orig(tag))
  );
  return { canvas, ctx };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('downscaleOversizedImage', () => {
  it('returns null when createImageBitmap is unavailable (degrade to original)', async () => {
    expect(await downscaleOversizedImage(fakeFile())).toBeNull();
  });

  it('returns null (never re-encodes) for images within the limit', async () => {
    const { close } = stubBitmap(MAX_IMAGE_DIMENSION, 500);
    stubCanvas();
    expect(await downscaleOversizedImage(fakeFile())).toBeNull();
    expect(close).toHaveBeenCalled();
  });

  it('returns null when decode fails', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('bad image'); }));
    expect(await downscaleOversizedImage(fakeFile())).toBeNull();
  });

  it('downscales an over-limit image to 4096 on the longest side, preserving aspect', async () => {
    const { close } = stubBitmap(9000, 4500);
    const { canvas, ctx } = stubCanvas();
    const out = await downscaleOversizedImage(fakeFile('image/png'));
    expect(out).toEqual({ url: 'data:image/png;base64,AAAA', mediaType: 'image/png' });
    expect(canvas.width).toBe(4096);
    expect(canvas.height).toBe(2048);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 4096, 2048);
    expect(close).toHaveBeenCalled();
  });

  it('triggers on height too, and keeps the JPEG type', async () => {
    stubBitmap(1000, 8001);
    const { canvas } = stubCanvas();
    const out = await downscaleOversizedImage(fakeFile('image/jpeg'));
    expect(out.mediaType).toBe('image/jpeg');
    expect(canvas.height).toBe(4096);
    expect(canvas.width).toBe(512); // 1000 * (4096/8001) rounded
  });

  it('re-encodes GIF as PNG (canvas cannot encode GIF)', async () => {
    stubBitmap(9000, 9000);
    const { canvas } = stubCanvas();
    const out = await downscaleOversizedImage(fakeFile('image/gif'));
    expect(out.mediaType).toBe('image/png');
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/png', 0.92);
  });

  it('returns null when the canvas encoder falls back to a different type', async () => {
    stubBitmap(9000, 9000);
    const { canvas } = stubCanvas();
    canvas.toDataURL = vi.fn(() => 'data:image/png;base64,AAAA'); // asked for webp, got png
    expect(await downscaleOversizedImage(fakeFile('image/webp'))).toBeNull();
  });
});
