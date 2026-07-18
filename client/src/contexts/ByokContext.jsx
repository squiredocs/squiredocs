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

  // The active chat model — only meaningful when BYOK is on (otherwise the chat
  // uses the shared server default, which is always a vision-capable provider).
  // The text-only models (GLM) are all BYOK-only, so gating image attachment on
  // the BYOK-selected model covers every text-only case.
  const activeModel = settings?.enabled && settings?.modelKey
    ? (settings.models || []).find((m) => m.key === settings.modelKey) || null
    : null;
  // Allow images unless BYOK selected a model explicitly flagged as text-only.
  const canAttachImages = !activeModel || activeModel.supportsImages !== false;
  const activeModelLabel = activeModel?.label || null;

  return (
    <ByokContext.Provider value={{ settings, loading, saving, error, saveSettings, clearKey, accentColor, canAttachImages, activeModelLabel }}>
      {children}
    </ByokContext.Provider>
  );
}

export function useByok() {
  const ctx = useContext(ByokContext);
  if (!ctx) throw new Error('useByok must be used within a ByokProvider');
  return ctx;
}
