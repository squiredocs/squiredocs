/**
 * BYOK (Bring Your Own Key) settings API
 *
 * Manages user-provided API keys for Anthropic and Google AI providers.
 * Keys are encrypted at rest and never returned to the client.
 */
const express = require('express');
const { requireAuth } = require('../auth');
const { encrypt } = require('../crypto');
const { MODEL_DEFS, getAvailableModels } = require('./chat-models');

const router = express.Router();

/**
 * Validate an API key by making a lightweight request to the provider.
 * Returns null on success, or an error message string on failure.
 */
async function validateApiKey(provider, apiKey) {
  try {
    if (provider === 'anthropic') {
      // Count tokens is the cheapest Anthropic endpoint — no model invocation
      const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      if (res.status === 401) return 'Invalid Anthropic API key';
      if (res.status === 403) return 'Anthropic API key does not have permission';
      if (!res.ok) return `Anthropic API returned status ${res.status}`;
    } else if (provider === 'google') {
      // List models is a free, auth-only endpoint
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1`
      );
      if (res.status === 400 || res.status === 403) return 'Invalid Google API key';
      if (!res.ok) return `Google API returned status ${res.status}`;
    }
    return null;
  } catch (err) {
    return `Failed to validate key: ${err.message}`;
  }
}

let pool = null;

function init(dbPool) {
  pool = dbPool;
}

function buildResponse(row) {
  const hasAnthropicKey = !!row.byok_anthropic_key;
  const hasGoogleKey = !!row.byok_google_key;
  return {
    enabled: row.byok_enabled,
    anthropic: { hasKey: hasAnthropicKey },
    google: { hasKey: hasGoogleKey },
    modelKey: row.byok_model_key,
    models: getAvailableModels(hasAnthropicKey, hasGoogleKey),
  };
}

// GET /api/settings/byok — return current BYOK state (never returns actual keys)
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT byok_enabled, byok_anthropic_key, byok_google_key, byok_model_key FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(buildResponse(result.rows[0]));
  } catch (err) {
    console.error('[BYOK] Error fetching settings:', err);
    res.status(500).json({ error: 'Failed to fetch BYOK settings' });
  }
});

// PUT /api/settings/byok — update BYOK settings
router.put('/', requireAuth, async (req, res) => {
  try {
    const { enabled, anthropicKey, googleKey, modelKey } = req.body;

    // Load current state to merge partial updates
    const current = await pool.query(
      `SELECT byok_enabled, byok_anthropic_key, byok_google_key, byok_model_key FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const row = current.rows[0];

    // Toggle
    let newEnabled = typeof enabled === 'boolean' ? enabled : row.byok_enabled;

    // Determine new values (undefined = no change, null = clear, string = set)
    // Validate keys against provider APIs before accepting them.
    let newAnthropicKey = row.byok_anthropic_key;
    if (anthropicKey === null) {
      newAnthropicKey = null;
    } else if (typeof anthropicKey === 'string' && anthropicKey.length > 0) {
      const err = await validateApiKey('anthropic', anthropicKey);
      if (err) return res.status(400).json({ error: err });
      newAnthropicKey = encrypt(anthropicKey);
    }

    let newGoogleKey = row.byok_google_key;
    if (googleKey === null) {
      newGoogleKey = null;
    } else if (typeof googleKey === 'string' && googleKey.length > 0) {
      const err = await validateApiKey('google', googleKey);
      if (err) return res.status(400).json({ error: err });
      newGoogleKey = encrypt(googleKey);
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

    // If the selected model's provider key was cleared, disable BYOK
    if (newEnabled && newModelKey) {
      const selectedDef = MODEL_DEFS.find((d) => d.key === newModelKey);
      const hasProviderKey = selectedDef?.provider === 'anthropic' ? !!newAnthropicKey : !!newGoogleKey;
      if (!hasProviderKey) newEnabled = false;
    }

    await pool.query(
      `UPDATE users SET byok_enabled = $1, byok_anthropic_key = $2, byok_google_key = $3, byok_model_key = $4, updated_at = now() WHERE id = $5`,
      [newEnabled, newAnthropicKey, newGoogleKey, newModelKey, req.user.userId]
    );

    res.json(buildResponse({
      byok_enabled: newEnabled,
      byok_anthropic_key: newAnthropicKey,
      byok_google_key: newGoogleKey,
      byok_model_key: newModelKey,
    }));
  } catch (err) {
    console.error('[BYOK] Error saving settings:', err);
    res.status(500).json({ error: 'Failed to save BYOK settings' });
  }
});

module.exports = { router, init };
