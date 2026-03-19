/**
 * Settings Page
 *
 * User account settings and preferences, including authorized AI agents.
 */
import { useState, useEffect } from 'react';
import AgentDelegationList from '../components/AgentDelegationList';
import ApiTokenList from '../components/ApiTokenList';
import Logo from '../components/Logo';
import UserProfileBadge from '../components/UserProfileBadge';
import { useAuth } from '../contexts/AuthContext';
import { useByok } from '../contexts/ByokContext';

function ByokKeyField({ label, provider, mask, placeholder, byok, onError }) {
  const [input, setInput] = useState('');
  const hasKey = byok.settings[provider]?.hasKey;

  return (
    <div className="byok-key-row">
      <label>{label}</label>
      {hasKey ? (
        <div className="byok-key-saved">
          <code className="byok-key-masked">{mask}</code>
          <button
            className="byok-key-clear"
            onClick={async () => {
              onError(null);
              try { await byok.clearKey(provider); } catch (err) { onError(err.message); }
            }}
            disabled={byok.saving}
          >
            Clear
          </button>
        </div>
      ) : (
        <div className="byok-key-input-row">
          <input
            className="byok-key-input"
            type="password"
            placeholder={placeholder}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={byok.saving}
          />
          <button
            className="byok-key-save"
            onClick={async () => {
              if (!input.trim()) return;
              onError(null);
              const saveKey = provider === 'anthropic' ? 'anthropicKey' : 'googleKey';
              try {
                await byok.saveSettings({ [saveKey]: input.trim() });
                setInput('');
              } catch (err) { onError(err.message); }
            }}
            disabled={byok.saving || !input.trim()}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage({ onNavigateHome, onNavigateToAdmin, user }) {
  const { updateUser, api, logout } = useAuth();
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(user?.name || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [usage, setUsage] = useState(null);
  const [mcpCopied, setMcpCopied] = useState(false);
  const byok = useByok();
  const [byokError, setByokError] = useState(null);

  useEffect(() => {
    api.get('/api/usage')
      .then(res => setUsage(res.data))
      .catch(() => {});
  }, [api]);

  const handleSave = async () => {
    const trimmed = nameValue.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await updateUser({ name: trimmed });
      setEditingName(false);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to update name');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setNameValue(user?.name || '');
    setEditingName(false);
    setError(null);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') handleCancel();
  };

  return (
    <>
      <header className="app-header">
        <div className="app-header-content">
          <div className="app-header-left">
            <button className="back-btn" onClick={onNavigateHome} title="Back to Documents">
              <Logo />
            </button>
            <h1>Settings</h1>
          </div>
          <div className="app-header-right">
            <UserProfileBadge user={user} onLogout={logout} onNavigateToAdmin={onNavigateToAdmin} />
          </div>
        </div>
      </header>

      <div className="settings-page">
        <div className="settings-content">
          <section className="settings-section">
            <h2>Account</h2>
            <div className="settings-item">
              <label>Email</label>
              <div className="settings-value">{user?.email}</div>
            </div>
            <div className="settings-item">
              <label>Name</label>
              {editingName ? (
                <div className="settings-name-edit">
                  <input
                    className="settings-name-input"
                    type="text"
                    value={nameValue}
                    onChange={(e) => setNameValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    maxLength={255}
                    autoFocus
                    disabled={saving}
                  />
                  <button className="settings-name-save" onClick={handleSave} disabled={saving || !nameValue.trim()}>
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button className="settings-name-cancel" onClick={handleCancel} disabled={saving}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="settings-value settings-value-editable">
                  {user?.name}
                  <button
                    className="settings-edit-btn"
                    onClick={() => { setNameValue(user?.name || ''); setEditingName(true); }}
                    title="Edit name"
                  >
                    ✎
                  </button>
                </div>
              )}
              {error && <div className="settings-name-error">{error}</div>}
            </div>
          </section>

          <section className="settings-section">
            <h2>Squire Docs Assistant</h2>

            {usage && (
              <div className="settings-subsection">
                <h3>AI Usage</h3>
                <div className="usage-section-content">
                  {byok.settings?.enabled ? (
                    <p className="settings-description byok-usage-note">
                      You're using your own API key — usage is tracked but not limited.
                    </p>
                  ) : (
                    <div className="usage-stats">
                      <div className="usage-amounts">
                        <span className="usage-used">${(usage.usedCents / 100).toFixed(2)} used</span>
                        <span className="usage-total">${(usage.creditCents / 100).toFixed(2)} limit</span>
                      </div>
                      <div className="usage-bar-track">
                        <div
                          className={`usage-bar-fill${usage.usedCents >= usage.creditCents ? ' usage-bar-exceeded' : ''}`}
                          style={{ width: `${Math.min(100, (usage.usedCents / usage.creditCents) * 100)}%` }}
                        />
                      </div>
                      <div className="usage-footer">
                        <span className="usage-remaining">
                          ${(usage.remainingCents / 100).toFixed(2)} remaining
                        </span>
                        <span className="usage-resets">
                          Resets {new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}
                        </span>
                      </div>
                    </div>
                  )}
                  <p className="settings-description usage-beta-note">
                    Squire Docs is currently in public beta and accepting design partners.
                    To increase your usage limit, reach out to <a href="mailto:contact@squiredocs.com">contact@squiredocs.com</a>.
                  </p>
                </div>
              </div>
            )}

            {byok.settings && (
              <div className="settings-subsection">
                <h3>Bring Your Own Key</h3>
                <p className="settings-description">
                  Configure the built-in assistant to use your AI provider account and choice of model.
                </p>

                <div className="byok-enable-row">
                  <label>Use my key</label>
                  <button
                    className={`byok-enable-toggle${byok.settings.enabled ? ' byok-enable-toggle--on' : ''}`}
                    onClick={async () => {
                      setByokError(null);
                      try { await byok.saveSettings({ enabled: !byok.settings.enabled }); } catch (err) { setByokError(err.message); }
                    }}
                    disabled={byok.saving}
                    role="switch"
                    aria-checked={byok.settings.enabled}
                  >
                    <span className="byok-enable-toggle-knob" />
                  </button>
                </div>
                {byokError && <div className="byok-error">{byokError}</div>}

                <ByokKeyField label="Anthropic Key" provider="anthropic" mask="sk-ant-••••••" placeholder="sk-ant-..." byok={byok} onError={setByokError} />
                <ByokKeyField label="Google Key" provider="google" mask="AIza••••••" placeholder="AIza..." byok={byok} onError={setByokError} />
                <p className="settings-description byok-note">
                  Keys are encrypted and never exposed. Using your own key bypasses AI usage limits.
                </p>

                <div className="byok-model-select">
                  <label>Model</label>
                  <select
                    className="byok-model-dropdown"
                    value={byok.settings.modelKey || ''}
                    onChange={async (e) => {
                      setByokError(null);
                      try {
                        await byok.saveSettings({ modelKey: e.target.value || null });
                      } catch (err) {
                        setByokError(err.message);
                      }
                    }}
                    disabled={byok.saving}
                  >
                    <option value="" disabled>Select a model...</option>
                    <optgroup label="Anthropic">
                      {byok.settings.models
                        ?.filter(m => m.provider === 'anthropic')
                        .map(m => (
                          <option key={m.key} value={m.key} disabled={!byok.settings.anthropic?.hasKey}>
                            {m.label || m.key}
                          </option>
                        ))}
                    </optgroup>
                    <optgroup label="Google">
                      {byok.settings.models
                        ?.filter(m => m.provider === 'google')
                        .map(m => (
                          <option key={m.key} value={m.key} disabled={!byok.settings.google?.hasKey}>
                            {m.label || m.key}
                          </option>
                        ))}
                    </optgroup>
                  </select>
                </div>
              </div>
            )}
          </section>

          <section className="settings-section">
            <h2>AI Agent Access</h2>
            <p className="settings-description">
              Connect AI agents to Squire Docs via MCP using OAuth or API tokens.
            </p>

            <div className="mcp-url-row">
              <code className="mcp-url">https://squiredocs.com/mcp</code>
              <button
                className="btn-copy-mcp"
                onClick={() => {
                  navigator.clipboard.writeText('https://squiredocs.com/mcp');
                  setMcpCopied(true);
                  setTimeout(() => setMcpCopied(false), 2000);
                }}
              >
                {mcpCopied ? 'Copied!' : 'Copy'}
              </button>
            </div>

            <div className="settings-subsection">
              <AgentDelegationList />
            </div>

            <div className="settings-subsection">
              <ApiTokenList />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
