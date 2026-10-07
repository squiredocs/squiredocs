/**
 * Sign-in provider registry (feature 059, FR-015 to FR-023, research R4/R5).
 *
 * One list of the ways an instance can be signed in to. In 059 it knows:
 *
 *   google  enabled in team mode when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
 *           are set; listed on the sign-in and consent pages; counts for the
 *           boot check.
 *   dev     the feature 029 faucet, enabled whenever devEndpointsEnabled()
 *           (any mode, RBD-059-1); never listed (RBD-059-19), so the hosted
 *           page's snapshot holds in development; counts for the boot check
 *           so a dev server without Google credentials still boots in team
 *           mode.
 *
 * Sign-in links are not a provider: they are minted inside the container and
 * work in every mode.
 *
 * Feature 061 adds entries here (OIDC, password) without touching the pages,
 * which render whatever `getPublicProviderInfo` returns.
 *
 * Requires no JWT module, so the `squire` CLI can load it.
 */
const { getInstanceConfig } = require('../instance-config');
const { devEndpointsEnabled } = require('./dev-endpoints');
const { hasOwner } = require('./instance-owner');

function present(v) {
  return typeof v === 'string' && v !== '';
}

function googleConfigured(env) {
  return present(env.GOOGLE_CLIENT_ID) && present(env.GOOGLE_CLIENT_SECRET);
}

/**
 * The enabled providers for a mode and environment.
 * @param {{ mode: 'local'|'team', env?: object }} opts
 * @returns {Array<{ id: string, label: string, startPath: string|null,
 *   listed: boolean, countsForBoot: boolean }>}
 */
function getProviders({ mode, env = process.env }) {
  const out = [];
  if (mode === 'team' && googleConfigured(env)) {
    out.push({ id: 'google', label: 'Google', startPath: '/auth/google', listed: true, countsForBoot: true });
  }
  if (devEndpointsEnabled()) {
    out.push({ id: 'dev', label: 'Dev faucet', startPath: null, listed: false, countsForBoot: true });
  }
  return out;
}

/**
 * Providers that are configured but switched off by the mode (FR-023).
 * @returns {Array<{ id: string, label: string }>}
 */
function getConfiguredButInactive({ mode, env = process.env }) {
  if (mode === 'local' && googleConfigured(env)) return [{ id: 'google', label: 'Google' }];
  return [];
}

const TEAM_NEEDS_PROVIDER =
  'SQUIRE_MODE=team needs at least one sign-in provider. Set GOOGLE_CLIENT_ID and ' +
  'GOOGLE_CLIENT_SECRET, or use SQUIRE_MODE=local.';

/**
 * Pure boot check (FR-021).
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function checkBootProviders({ mode, providers }) {
  if (mode === 'team' && !providers.some((p) => p.countsForBoot)) {
    return { ok: false, message: TEAM_NEEDS_PROVIDER };
  }
  return { ok: true };
}

/** The one boot line naming the mode (FR-020, FR-023). */
function modeLine(mode, providers) {
  if (mode === 'local') {
    return '[Auth] Instance mode: local (sign in with: docker compose exec app squire claim-link)';
  }
  const listed = providers.filter((p) => p.listed).map((p) => p.id);
  return `[Auth] Instance mode: team (providers: ${listed.length ? listed.join(', ') : 'none listed'})`;
}

/**
 * Called by server/index.js before the first app.listen. Logs the mode line
 * and any configured-but-inactive provider; on a team instance with no
 * provider, logs the FATAL line and calls exit(1).
 *
 * @param {{ log?: { log: Function, error: Function }, exit?: Function, env?: object }} [opts]
 * @returns {boolean} true when bootable
 */
function assertBootable({ log = console, exit = process.exit, env = process.env } = {}) {
  const { mode } = getInstanceConfig();
  const providers = getProviders({ mode, env });
  const check = checkBootProviders({ mode, providers });
  if (!check.ok) {
    log.error(`[Auth] FATAL: ${check.message}`);
    exit(1);
    return false;
  }
  log.log(modeLine(mode, providers));
  for (const p of getConfiguredButInactive({ mode, env })) {
    log.log(`[Auth] ${p.label} sign-in is configured but inactive in local mode (set SQUIRE_MODE=team to enable it)`);
  }
  return true;
}

/**
 * The body of GET /auth/providers (FR-016, FR-047). Exactly the contract's
 * keys; never client ids, secrets, redirect URIs, user counts, or the faucet.
 * An owner-probe failure reports hasOwner false and logs, so the sign-in page
 * never fails because of it.
 *
 * @param {{ query: Function }} db
 */
async function getPublicProviderInfo(db, { env = process.env, log = console } = {}) {
  const { mode } = getInstanceConfig();
  let owner = false;
  try {
    owner = await hasOwner(db);
  } catch (err) {
    log.error('[Auth] owner probe failed for /auth/providers:', err?.message || err);
  }
  return {
    mode,
    hasOwner: owner,
    signupOpen: mode === 'team',
    providers: getProviders({ mode, env })
      .filter((p) => p.listed)
      .map(({ id, label, startPath }) => ({ id, label, startPath })),
  };
}

module.exports = {
  TEAM_NEEDS_PROVIDER,
  getProviders,
  getConfiguredButInactive,
  checkBootProviders,
  assertBootable,
  getPublicProviderInfo,
};
