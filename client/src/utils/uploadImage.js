/**
 * Upload a document image through the app to S3-backed storage.
 *
 * The server stores the bytes and returns a short app URL
 * (/api/docs/:docId/images/:imageId) that is what gets embedded in the
 * document — never the bytes themselves.
 */
import { isImageType } from './media';

// Mirror the server-side cap (server/index.js MAX_IMAGE_BYTES).
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Read a File as a bare base64 string (without the data: URL prefix). */
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Upload an image file and return its app URL reference.
 * @param {import('axios').AxiosInstance} api - Authenticated axios instance
 * @param {string} docId - Document UUID the image belongs to
 * @param {File} file - Image file
 * @returns {Promise<{id: string, url: string}>}
 */
export async function uploadDocumentImage(api, docId, file) {
  if (!isImageType(file.type)) {
    throw new Error('Unsupported image type');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('Image exceeds the 15MB limit');
  }

  const dataBase64 = await readAsBase64(file);
  const response = await api.post(`/api/docs/${docId}/images`, {
    filename: file.name,
    mimeType: file.type,
    dataBase64,
  });
  return response.data; // { id, url }
}
