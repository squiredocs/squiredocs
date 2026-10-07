/**
 * Dev-endpoint gate (feature 029), moved here unchanged by feature 059.
 *
 * Requires nothing, so server/auth/providers.js and the `squire` CLI can use it
 * without loading server/auth/jwt.js (which throws at require time in
 * production when the secrets are missing).
 */

/**
 * Feature 029: shared fail-closed gate for dev-only support endpoints.
 *
 * Two independent conditions, BOTH required (the 2b9d6be pattern, RBD-5):
 *   1. ENABLE_DEV_ENDPOINTS === '1' — the EXPLICIT positive opt-in that is the
 *      primary, required, fail-closed gate. Absent ⇒ off, independent of
 *      NODE_ENV. Set only in the minikube dev overlay and the test setup.
 *   2. NODE_ENV !== 'production' — belt-and-suspenders: even if the flag is ever
 *      set by accident in a prod-like env, production still blocks it.
 *
 * The invariant forbids the NODE_ENV negative as the SOLE gate (the 2026-07-21
 * incident: NODE_ENV was unset in prod, so negatively-gated routes were live);
 * it is kept here only as an ADDITIONAL guard on top of the positive flag.
 *
 * Evaluated per-request (not at module load) so the reachability tests can
 * toggle the environment between requests on a single app instance.
 *
 * @returns {boolean} true iff the synthetic dev endpoints may be reached.
 */
function devEndpointsEnabled() {
  return process.env.ENABLE_DEV_ENDPOINTS === '1' && process.env.NODE_ENV !== 'production';
}

module.exports = { devEndpointsEnabled };
