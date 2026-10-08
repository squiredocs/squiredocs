/**
 * BYOK (Bring Your Own Key) context.
 *
 * Shares BYOK settings state across the app so that changes
 * in Settings are immediately reflected in the AI panel.
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAuth } from './AuthContext';

const ByokContext = createContext(null);

export function ByokProvider({ children }) {
  const { api } = useAuth();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await api.get('/api/settings/byok');
      setSettings(res.data);
    } catch {
      setSettings(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSettings = useCallback(async (updates) => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.put('/api/settings/byok', updates);
      setSettings(res.data);
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to save settings';
      setError(msg);
      throw new Error(msg);
    } finally {
      setSaving(false);
    }
  }, [api]);

  const clearKey = useCallback(async (provider) => {
    await saveSettings({ [`${provider}Key`]: null });
  }, [saveSettings]);

  const accentColor = settings?.enabled ? '#312e81' : '#7c3aed';

  // The active chat model — known here only when BYOK is on. A non-BYOK user's
  // model is resolved server-side and deliberately not disclosed (035 FR-011),
  // so this gate cannot see it.
  //
  // KNOWN GAP (035 review, MEDIUM): the shared path is NOT guaranteed vision-
  // capable any more — every `or-*` gateway entry is shared-eligible once
  // OPENROUTER_API_KEY is set, and several are text-only, so an admin-set shared
  // default or a per-user pin can land a user on a text-only model. Their attach
  // button stays enabled and the turn fails server-side with
  // `model_no_image_support`. The admin picker warns when pinning such a model;
  // closing it properly means exposing an effective supportsImages boolean (a
  // capability, not the pin) on an authenticated payload and gating on that.
  const activeModel = settings?.enabled && settings?.modelKey
    ? (settings.models || []).find((m) => m.key === settings.modelKey) || null
    : null;
  // Allow images unless BYOK selected a model explicitly flagged as text-only.
  const canAttachImages = !activeModel || activeModel.supportsImages !== false;
  const activeModelLabel = activeModel?.label || null;

  // The server reports whether the assistant can answer this user at all: a
  // shared server key backs some model, or the user's own key is fully set up
  // (key saved, "Use my key" on, model picked). False on a self-hosted instance
  // with no assistant keys, where the panel shows a setup state instead of
  // sending a turn that can only fail. Unknown (still loading, fetch failed, or
  // an older server without the field) counts as available, so the panel never
  // flashes the setup state and the server's assistant_not_configured code
  // remains the backstop. Saving BYOK updates `settings`, so the panel recovers
  // with no reload.
  const assistantUnavailable = !loading && settings?.assistantAvailable === false;

  return (
    <ByokContext.Provider value={{ settings, loading, saving, error, saveSettings, clearKey, accentColor, canAttachImages, activeModelLabel, assistantUnavailable }}>
      {children}
    </ByokContext.Provider>
  );
}

export function useByok() {
  const ctx = useContext(ByokContext);
  if (!ctx) throw new Error('useByok must be used within a ByokProvider');
  return ctx;
}
