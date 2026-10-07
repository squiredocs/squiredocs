/**
 * Response helper shared by the raw image routes (feature 058,
 * contracts/http-routes.md): document images and chat attachments.
 *
 * The bytes were validated at upload (MIME allow-list, size cap). `nosniff`
 * and a sandboxing CSP stop a stored file from ever executing as a document
 * on this origin, even if a future allow-list widens (Constitution V,
 * RBD-058-21). `private` keeps shared caches from storing per-user bytes, and
 * `no-cache` makes the browser revalidate (cheap with Express's ETag), so the
 * access check re-runs and revoked access takes effect at once (058 review L2).
 */
const RAW_IMAGE_CSP = "default-src 'none'; sandbox";

function sendRawImage(res, { body, contentType }) {
  res.set({
    'Content-Type': contentType,
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': RAW_IMAGE_CSP,
  });
  return res.status(200).send(body);
}

module.exports = { sendRawImage, RAW_IMAGE_CSP };
