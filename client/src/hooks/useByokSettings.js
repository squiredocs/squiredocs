/**
 * Hook for managing BYOK (Bring Your Own Key) settings.
 *
 * Fetches the current BYOK state on mount and exposes helpers
 * for saving keys, clearing keys, and changing the model.
 */
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function useByokSettings() {
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
      // BYOK not available (e.g. columns not migrated yet)
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
    const updates = {};
    if (provider === 'anthropic') updates.anthropicKey = null;
    if (provider === 'google') updates.googleKey = null;
    await saveSettings(updates);
  }, [saveSettings]);

  return { settings, loading, saving, error, saveSettings, clearKey };
}
