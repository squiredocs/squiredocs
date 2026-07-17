/**
 * Build the public base URL from an Express request.
 *
 * The app runs behind CloudFront, which terminates TLS for the public host
 * (squiredocs.com) and forwards to its origin with `Host: app.squiredocs.com`
 * — an internal origin hostname that viewers never reach directly (its 443 is
 * prefix-list-scoped). If we echoed that Host back, every absolute URL the
 * server emits — MCP tool `url` fields, token-claim URLs and curl examples,
 * the OAuth discovery document, share links, and the in-app assistant's
 * system prompt — would advertise `app.squiredocs.com` as the canonical URL.
 * So we map the known origin host(s) back to the canonical public origin.
 *
 * Both the public origin and the set of internal origin aliases are
 * overridable via env (PUBLIC_ORIGIN / ORIGIN_HOST_ALIASES) but default to
 * production reality, so no deploy config change is required. Hosts that are
 * neither the origin alias nor a squiredocs.com host (local dev, minikube,
 * tests) are returned unchanged.
 */
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://squiredocs.com';

const ORIGIN_HOST_ALIASES = new Set(
  (process.env.ORIGIN_HOST_ALIASES || 'app.squiredocs.com')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

function buildBaseUrl(req) {
  const host = req.get('host');
  if (host) {
    // Compare on the bare hostname so a :port suffix never defeats the match.
    const bareHost = host.toLowerCase().split(':')[0];
    if (ORIGIN_HOST_ALIASES.has(bareHost)) return PUBLIC_ORIGIN;
  }
  const protocol = host && host.includes('squiredocs.com') ? 'https' : req.protocol;
  return `${protocol}://${host}`;
}

module.exports = { buildBaseUrl };
