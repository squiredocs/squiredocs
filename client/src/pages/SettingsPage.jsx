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
          
          <div className="connection-instructions">
            <h3 className="connection-title">Connect an AI Agent:</h3>
            <div className="connection-step">
              <span className="step-number">1</span>
              <div className="step-content">
                <p className="step-text">Configure your agent to connect to our MCP server:</p>
                <code className="mcp-url">https://herodocs.xyz/mcp</code>
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
            <a 
              href="https://claude.ai/settings/connectors?modal=add-custom-connector" 
              target="_blank" 
              rel="noopener noreferrer"
              className="connect-claude-btn"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="claude-icon">
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
          </div>
          
          <AgentDelegationList />
        </section>
      </div>
    </div>
  );
}
