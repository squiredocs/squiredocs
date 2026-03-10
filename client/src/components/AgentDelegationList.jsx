/**
 * Agent Delegation List
 *
 * Displays and manages user's authorized AI agents.
 */
import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

// Simple time formatter
function formatTimeAgo(date) {
  const now = new Date();
  const past = new Date(date);
  const seconds = Math.floor((now - past) / 1000);

  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

export default function AgentDelegationList() {
  const { api } = useAuth();
  const [delegations, setDelegations] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchDelegations();
  }, []);

  const fetchDelegations = async () => {
    try {
      setIsLoading(true);
      const response = await api.get('/mcp/auth/delegations');

      if (response.data.error) {
        setError(response.data.error);
      } else {
        setDelegations(response.data.delegations || []);
      }
    } catch (err) {
      console.error('Error fetching delegations:', err);
      setError(err.response?.data?.error || err.message || 'Failed to load authorized agents');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevoke = async (delegationId, agentName) => {
    if (!confirm(`Revoke access for ${agentName}? This will sign out the agent.`)) {
      return;
    }

    try {
      await api.delete(`/mcp/auth/delegations/${delegationId}`);
      setDelegations(prev => prev.filter(d => d.id !== delegationId));
    } catch (err) {
      console.error('Error revoking delegation:', err);
      alert(err.response?.data?.error || err.message || 'Failed to revoke access');
    }
  };

  if (isLoading) {
    return <div className="loading">Loading authorized agents...</div>;
  }

  if (error) {
    return <div className="error">{error}</div>;
  }

  return (
    <div className="delegation-list">
      <div className="delegation-section-header">
        <h3>OAuth</h3>
        <div className="connect-buttons">
          <a
            href="https://claude.ai/settings/connectors?modal=add-custom-connector"
            target="_blank"
            rel="noopener noreferrer"
            className="connect-btn"
          >
            Connect Claude
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="external-icon">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <polyline points="15 3 21 3 21 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </a>
          <a
            href="https://chatgpt.com/apps#settings/Connectors/Advanced"
            target="_blank"
            rel="noopener noreferrer"
            className="connect-btn"
          >
            Connect ChatGPT
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="external-icon">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <polyline points="15 3 21 3 21 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </a>
        </div>
      </div>
      <p className="settings-description">Agents authorized via the interactive OAuth flow with scoped, time-limited access.</p>
      {delegations.length === 0 ? (
        <p className="settings-empty-text">No agents authorized yet. Use the MCP server URL above to connect one.</p>
      ) : (
        <ul>
          {delegations.map(delegation => (
            <li key={delegation.id} className="delegation-card">
              <div className="delegation-header">
                <div className="agent-info">
                  <strong>{delegation.agentName}</strong>
                  {delegation.description && (
                    <span className="description">{delegation.description}</span>
                  )}
                </div>
                <button
                  className="btn-revoke"
                  onClick={() => handleRevoke(delegation.id, delegation.agentName)}
                >
                  Revoke
                </button>
              </div>
              <div className="delegation-meta">
                <span>{delegation.scopes.join(', ')}</span>
                <span>Authorized {formatTimeAgo(delegation.createdAt)}</span>
                {delegation.lastUsedAt && (
                  <span>Last used {formatTimeAgo(delegation.lastUsedAt)}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
