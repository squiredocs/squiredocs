/**
 * Instance configuration injected by the server into the app shell (feature
 * 058, contracts/http-routes.md): window.__SQUIRE_INSTANCE__ = { hosted }.
 *
 * isHosted() is true only for the literal boolean true. A page that somehow
 * lacks the injection behaves as self-hosted, which never shows hosted-service
 * text (pricing, beta credits, legal links).
 */
export function isHosted() {
  return typeof window !== 'undefined' && window.__SQUIRE_INSTANCE__?.hosted === true;
}
