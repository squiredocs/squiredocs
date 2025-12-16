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

  if (delegations.length === 0) {
    return (
      <div className="empty-state">
        <h3>No authorized agents</h3>
        <p>AI agents like Claude Code can request access to your documents using OAuth.</p>
        <p>When an agent requests authorization, you'll see a consent screen where you can approve or deny access. Authorized agents will appear here.</p>
      </div>
    );
  }

  return (
    <div className="delegation-list">
      <h3>Authorized AI Agents</h3>
      <p className="subtitle">
        These applications can access your documents on your behalf.
      </p>

      <ul>
        {delegations.map(delegation => (
          <li key={delegation.id} className="delegation-card">
            <div className="delegation-header">
              {delegation.iconUrl ? (
                <img src={delegation.iconUrl} alt="" className="agent-icon" />
              ) : (
                <div className="agent-icon default">🤖</div>
              )}
              <div className="agent-info">
                <strong>{delegation.agentName}</strong>
                {delegation.description && (
                  <p className="description">{delegation.description}</p>
                )}
              </div>
            </div>

            <div className="delegation-details">
              <div className="scopes">
                <span className="label">Permissions:</span>
                <span className="value">{delegation.scopes.join(', ')}</span>
              </div>
              <div className="dates">
                <span>
                  Authorized {formatTimeAgo(delegation.createdAt)}
                </span>
                {delegation.lastUsedAt && (
                  <span>
                    Last used {formatTimeAgo(delegation.lastUsedAt)}
                  </span>
                )}
              </div>
            </div>

            <button
              className="btn-revoke"
              onClick={() => handleRevoke(delegation.id, delegation.agentName)}
            >
              Revoke Access
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
