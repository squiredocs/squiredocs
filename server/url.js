/**
 * Build the public base URL from an Express request.
 * Forces HTTPS for production domains.
 */
function buildBaseUrl(req) {
  const host = req.get('host');
  const protocol = host && host.includes('squiredocs.com') ? 'https' : req.protocol;
  return `${protocol}://${host}`;
}

module.exports = { buildBaseUrl };
