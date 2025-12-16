/**
 * Settings Page
 *
 * User account settings and preferences, including authorized AI agents.
 */
import AgentDelegationList from '../components/AgentDelegationList';

export default function SettingsPage({ onNavigateHome, user }) {
  return (
    <div className="settings-page">
      <div className="settings-header">
        <button className="back-btn" onClick={onNavigateHome}>
          ← Back to Documents
        </button>
        <h1>Settings</h1>
      </div>

      <div className="settings-content">
        <section className="settings-section">
          <h2>Account</h2>
          <div className="settings-item">
            <label>Email</label>
            <div className="settings-value">{user?.email}</div>
          </div>
          <div className="settings-item">
            <label>Name</label>
            <div className="settings-value">{user?.name}</div>
          </div>
        </section>

        <section className="settings-section">
          <h2>AI Agent Access</h2>
          <p className="settings-description">
            Manage which AI agents can access your documents on your behalf.
            These agents use OAuth to securely act on your behalf with the permissions you grant.
          </p>
          <AgentDelegationList />
        </section>
      </div>
    </div>
  );
}
