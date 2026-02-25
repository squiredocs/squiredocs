/**
 * Build the public base URL from an Express request.
 * Forces HTTPS for production domains.
 */
function buildBaseUrl(req) {
  const host = req.get('host');
  const protocol = host && host.includes('herodocs.xyz') ? 'https' : req.protocol;
  return `${protocol}://${host}`;
}

module.exports = { buildBaseUrl };
