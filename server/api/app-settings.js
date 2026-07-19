/**
 * App-wide settings — a tiny key/value store for global, admin-editable
 * configuration, backed by the app_settings table.
 *
 * Currently holds a single setting: the shared-assistant default chat model
 * ('shared_default_model'), changed from the Admin page. Values are cached in
 * memory so the hot chat path (resolveChatModel) can read the shared default
 * synchronously without a DB round-trip per request. The cache is loaded once at
 * startup (init) and kept in sync on every write.
 */

const SHARED_DEFAULT_MODEL = 'shared_default_model';

/**
 * Feature 021 kill-switch for the client editor-binding hardening patch.
 * Absent or 'true' = hardened behaviors ON (default); 'false' = kill-switch
 * engaged, the client binding reverts to stock. Delivered to browsers via
 * GET /api/client-config; flipped from the admin settings endpoint. The
 * server guardrail and the quarantine layer are independent of this flag
 * (DR-2).
 */
const COLLAB_BINDING_HARDENING = 'collab_binding_hardening';

let pool = null;
const cache = new Map();

/**
 * Store the pool and warm the in-memory cache. Safe to call before the
 * app_settings table exists (e.g. migrations not yet run): the load error is
 * swallowed and the cache stays empty, so callers fall back to their defaults.
 */
async function init(dbPool) {
  pool = dbPool;
  await refresh();
}

/** Reload all settings from the database into the cache. */
async function refresh() {
  if (!pool) return;
  try {
    const { rows } = await pool.query('SELECT key, value FROM app_settings');
    cache.clear();
    for (const r of rows) cache.set(r.key, r.value);
  } catch (err) {
    console.error('[AppSettings] Failed to load settings:', err.message);
  }
}

/** Read a setting from cache. Returns null when unset. */
function getSetting(key) {
  return cache.has(key) ? cache.get(key) : null;
}

/** Upsert a setting (or clear it when value is null) and update the cache. */
async function setSetting(key, value) {
  if (value === null) {
    await pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
    cache.delete(key);
    return;
  }
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
  cache.set(key, value);
}

/**
 * Whether the 021 binding-hardening patch is enabled. True unless the stored
 * value is exactly 'false' (absent = default ON — fail-safe).
 */
function getCollabBindingHardening() {
  return getSetting(COLLAB_BINDING_HARDENING) !== 'false';
}

/**
 * Engage/release the 021 kill-switch. Enabled clears the row (unset = ON keeps
 * the default-ON invariant literal in the store); disabled stores 'false'.
 * setSetting writes through the cache, so the flip is immediate — no restart.
 */
async function setCollabBindingHardening(enabled) {
  await setSetting(COLLAB_BINDING_HARDENING, enabled ? null : 'false');
}

/** The admin-selected shared-assistant default model key, or null when unset. */
function getSharedDefaultModel() {
  return getSetting(SHARED_DEFAULT_MODEL);
}

/** Set (or clear, when null) the shared-assistant default model key. */
async function setSharedDefaultModel(modelKey) {
  await setSetting(SHARED_DEFAULT_MODEL, modelKey);
}

module.exports = {
  init,
  refresh,
  getSetting,
  setSetting,
  getSharedDefaultModel,
  setSharedDefaultModel,
  getCollabBindingHardening,
  setCollabBindingHardening,
  SHARED_DEFAULT_MODEL,
  COLLAB_BINDING_HARDENING,
};
