/**
 * Settings Page
 *
 * User account settings and preferences, including authorized AI agents.
 */
import { useState, useEffect } from 'react';
import AgentDelegationList from '../components/AgentDelegationList';
import UserProfileBadge from '../components/UserProfileBadge';
import { useAuth } from '../contexts/AuthContext';

export default function SettingsPage({ onNavigateHome, user }) {
  const { updateUser, api, logout } = useAuth();
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(user?.name || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [usage, setUsage] = useState(null);

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
            <button className="back-btn" onClick={onNavigateHome}>
              ← Back to Documents
            </button>
            <h1>Settings</h1>
          </div>
          <div className="app-header-right">
            <UserProfileBadge user={user} onLogout={logout} />
          </div>
        </div>
      </header>

      <div className="settings-page">
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
                  {saving ? 'Saving…' : 'Save'}
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

        {usage && (
          <section className="settings-section">
            <h2>AI Usage</h2>
            <p className="settings-description">
              Your AI assistant usage for the current billing month.
            </p>
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
            <p className="settings-description usage-beta-note">
              Squire Docs is currently in public beta and accepting design partners.
              To increase your usage limit, reach out to <a href="mailto:contact@squiredocs.com">contact@squiredocs.com</a>.
            </p>
          </section>
        )}

        <section className="settings-section">
          <h2>AI Agent Access</h2>
          <p className="settings-description">
            Manage which AI agents can access your documents on your behalf.
            These agents use OAuth to securely act on your behalf with the permissions you grant.
          </p>

          <div className="connection-instructions">
            <h3 className="connection-title">Connect an AI Agent:</h3>
            <div className="connection-step">
              <span className="step-number">1</span>
              <div className="step-content">
                <p className="step-text">Configure your agent to connect to our MCP server:</p>
                <code className="mcp-url">https://squiredocs.com/mcp</code>
              </div>
            </div>
            <div className="connection-step">
              <span className="step-number">2</span>
              <div className="step-content">
                <p className="step-text">Complete the OAuth flow in your browser to approve Agent access.</p>
              </div>
            </div>
          </div>

          <div className="connect-section">
            <h3 className="connect-section-title">Connect</h3>
            <div className="connect-buttons">
              <a
                href="https://claude.ai/settings/connectors?modal=add-custom-connector"
                target="_blank"
                rel="noopener noreferrer"
                className="connect-btn connect-claude-btn"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="connect-icon">
                  <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Connect Claude
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="external-icon">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <polyline points="15 3 21 3 21 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </a>
              <a
                href="https://chatgpt.com/apps#settings/Connectors/Advanced"
                target="_blank"
                rel="noopener noreferrer"
                className="connect-btn connect-chatgpt-btn"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="connect-icon">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M8 10h.01M12 10h.01M16 10h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                Connect ChatGPT
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="external-icon">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <polyline points="15 3 21 3 21 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </a>
            </div>
          </div>

          <AgentDelegationList />
        </section>
      </div>
    </>
  );
}
