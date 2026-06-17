/**
 * BYOK (Bring Your Own Key) settings API
 *
 * Manages user-provided API keys for the AI providers defined in the provider
 * registry (server/api/ai-providers.js). Keys are encrypted at rest and never
 * returned to the client — only their presence is surfaced.
 */
const express = require('express');
const { requireAuth } = require('../auth');
const { encrypt } = require('../crypto');
const { MODEL_DEFS, getAvailableModels } = require('./chat-models');
const { getProviderConfig, listProviders } = require('./ai-providers');

const router = express.Router();

/**
 * Validate an API key by making a lightweight request to the provider (delegated
 * to the registry). Returns null on success, or an error message string.
 */
async function validateApiKey(provider, apiKey) {
  try {
    return await getProviderConfig(provider).validateKey(apiKey);
  } catch (err) {
    return `Failed to validate key: ${err.message}`;
  }
}

let pool = null;

function init(dbPool) {
  pool = dbPool;
}

/**
 * Build the client-facing response from a settings row. Emits a data-driven
 * `providers` array (id/label/placeholder/mask/hasKey) plus a per-provider
 * `{ hasKey }` object keyed by provider id for backwards compatibility.
 */
function buildResponse(row) {
  const hasKeyByProvider = {};
  const providers = listProviders().map((p) => {
    const hasKey = !!row[p.keyColumn];
    hasKeyByProvider[p.id] = hasKey;
    return { id: p.id, label: p.label, keyPlaceholder: p.keyPlaceholder, keyMask: p.keyMask, hasKey };
  });
  const response = {
    enabled: row.byok_enabled,
    providers,
    modelKey: row.byok_model_key,
    models: getAvailableModels(hasKeyByProvider),
  };
  for (const p of providers) response[p.id] = { hasKey: p.hasKey };
  return response;
}

// GET /api/settings/byok — return current BYOK state (never returns actual keys)
router.get('/', requireAuth, async (req, res) => {
  try {
    const row = await loadByokSettings(req.user.userId);
    if (!row) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(buildResponse(row));
  } catch (err) {
    console.error('[BYOK] Error fetching settings:', err);
    res.status(500).json({ error: 'Failed to fetch BYOK settings' });
  }
});

// PUT /api/settings/byok — update BYOK settings
router.put('/', requireAuth, async (req, res) => {
  try {
    const { enabled, modelKey } = req.body;

    // Load current state to merge partial updates
    const row = await loadByokSettings(req.user.userId);
    if (!row) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Toggle
    let newEnabled = typeof enabled === 'boolean' ? enabled : row.byok_enabled;

    // Resolve each provider's new key value, keyed by DB column.
    // For each provider the client sends `${id}Key` in the body:
    //   undefined = no change, null = clear, non-empty string = validate + set.
    const newKeys = {};
    for (const p of listProviders()) {
      const provided = req.body[`${p.id}Key`];
      let value = row[p.keyColumn];
      if (provided === null) {
        value = null;
      } else if (typeof provided === 'string' && provided.length > 0) {
        const err = await validateApiKey(p.id, provided);
        if (err) return res.status(400).json({ error: err });
        value = encrypt(provided);
      }
      newKeys[p.keyColumn] = value;
    }

    let newModelKey = row.byok_model_key;
    if (modelKey === null) {
      newModelKey = null;
    } else if (typeof modelKey === 'string') {
      const modelDef = MODEL_DEFS.find((d) => d.key === modelKey);
      if (!modelDef) {
        return res.status(400).json({ error: `Unknown model: ${modelKey}` });
      }
      newModelKey = modelKey;
    }

    // Enabling BYOK requires at least one API key to be present.
    // - Explicit toggle on → reject with error so the user knows why
    // - Key cleared while already on → silently disable (existing behavior)
    if (newEnabled) {
      const hasAnyKey = listProviders().some((p) => !!newKeys[p.keyColumn]);
      if (!hasAnyKey) {
        if (enabled === true) {
          return res.status(400).json({
            error: 'Add an API key before enabling BYOK',
          });
        }
        newEnabled = false;
      }
    }

    // Build the UPDATE dynamically from the registry's key columns. Column names
    // come from the registry (trusted), never from user input.
    const setParts = ['byok_enabled', 'byok_model_key'];
    const params = [newEnabled, newModelKey];
    for (const p of listProviders()) {
      params.push(newKeys[p.keyColumn]);
      setParts.push(p.keyColumn);
    }
    const assignments = setParts.map((col, i) => `${col} = $${i + 1}`).join(', ');
    params.push(req.user.userId);
    await pool.query(
      `UPDATE users SET ${assignments}, updated_at = now() WHERE id = $${params.length}`,
      params
    );

    res.json(buildResponse({
      byok_enabled: newEnabled,
      byok_model_key: newModelKey,
      ...newKeys,
    }));
  } catch (err) {
    console.error('[BYOK] Error saving settings:', err);
    res.status(500).json({ error: 'Failed to save BYOK settings' });
  }
});

/**
 * Load raw BYOK settings for a user from the database.
 * Returns null if user not found.
 */
async function loadByokSettings(userId) {
  const columns = ['byok_enabled', 'byok_model_key', ...listProviders().map((p) => p.keyColumn)];
  const result = await pool.query(
    `SELECT ${columns.join(', ')} FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

/**
 * Check whether BYOK is fully configured and active for a settings row.
 * Requires the toggle on, a model selected, and the matching provider key stored.
 */
function isByokActive(settings) {
  if (!settings?.byok_enabled || !settings.byok_model_key) return false;
  const def = MODEL_DEFS.find(d => d.key === settings.byok_model_key);
  if (!def) return false;
  return !!settings[getProviderConfig(def.provider).keyColumn];
}

module.exports = { router, init, loadByokSettings, isByokActive };
