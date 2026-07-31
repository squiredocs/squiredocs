/** True for an image MIME type (e.g. "image/png"). */
export const isImageType = (mediaType) => mediaType?.startsWith('image/');

// Anthropic rejects any image with a side over 8000px (400 invalid_request_error),
// which surfaced to users as a generic chat failure. Oversized images are
// downscaled client-side before attach; DOWNSCALE_TARGET stays far below the
// limit while keeping ample detail for re-viewing in the transcript (the model
// itself never sees more than ~1568px — the API downsamples).
export const MAX_IMAGE_DIMENSION = 8000;
const DOWNSCALE_TARGET = 4096;

/**
 * Downscale an image file iff one of its sides exceeds MAX_IMAGE_DIMENSION.
 *
 * Returns { url, mediaType } (a data URL ready to attach) when the image was
 * resized, or null when no resize is needed — or possible (no createImageBitmap
 * or canvas, decode failure). Null means "attach the original file unchanged",
 * i.e. every failure degrades to today's behavior. Legal-size images are never
 * re-encoded, so nothing that works today changes.
 *
 * JPEG/WebP keep their type (lossy re-encode); everything else lands on PNG —
 * notably GIF, which canvas can't encode and whose animation is lost, an
 * acceptable trade for an image the API would otherwise reject outright.
 */
export async function downscaleOversizedImage(file) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const { width, height } = bitmap;
    if (!(width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION)) return null;
    const scale = DOWNSCALE_TARGET / Math.max(width, height);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    const mediaType = (file.type === 'image/jpeg' || file.type === 'image/webp')
      ? file.type
      : 'image/png';
    const url = canvas.toDataURL(mediaType, 0.92);
    if (!url?.startsWith(`data:${mediaType}`)) return null;
    return { url, mediaType };
  } catch {
    return null;
  } finally {
    bitmap.close?.();
  }
}
