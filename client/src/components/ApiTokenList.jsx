/**
 * API Token List
 *
 * Manages personal access tokens for MCP API access.
 */
import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

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

export default function ApiTokenList() {
  const { api } = useAuth();
  const [tokens, setTokens] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [creating, setCreating] = useState(false);
  const [revealedToken, setRevealedToken] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchTokens();
  }, []);

  const fetchTokens = async () => {
    try {
      setIsLoading(true);
      const response = await api.get('/mcp/auth/api-tokens');
      setTokens(response.data.tokens || []);
    } catch (err) {
      console.error('Error fetching API tokens:', err);
      setError(err.response?.data?.error || err.message || 'Failed to load API tokens');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newTokenName.trim() || creating) return;

    try {
      setCreating(true);
      setError(null);
      const response = await api.post('/mcp/auth/api-tokens', { name: newTokenName.trim() });
      setRevealedToken(response.data);
      setNewTokenName('');
      setShowCreateForm(false);
    } catch (err) {
      console.error('Error creating API token:', err);
      setError(err.response?.data?.error || err.message || 'Failed to create token');
    } finally {
      setCreating(false);
    }
  };

  const handleDismissReveal = () => {
    // Add the new token to the list
    setTokens(prev => [{
      id: revealedToken.id,
      name: revealedToken.name,
      tokenPrefix: revealedToken.tokenPrefix,
      scopes: revealedToken.scopes,
      createdAt: revealedToken.createdAt,
      lastUsedAt: null,
    }, ...prev]);
    setRevealedToken(null);
    setCopied(false);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(revealedToken.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleRevoke = async (tokenId, tokenName) => {
    if (!confirm(`Revoke API token "${tokenName}"? This cannot be undone.`)) {
      return;
    }

    try {
      await api.delete(`/mcp/auth/api-tokens/${tokenId}`);
      setTokens(prev => prev.filter(t => t.id !== tokenId));
    } catch (err) {
      console.error('Error revoking API token:', err);
      alert(err.response?.data?.error || err.message || 'Failed to revoke token');
    }
  };

  if (isLoading) {
    return <div className="loading">Loading API tokens...</div>;
  }

  return (
    <div className="api-token-section">
      <div className="api-token-section-header">
        <h3>API Tokens</h3>
        {!showCreateForm && (
          <button
            className="btn-create-token"
            onClick={() => setShowCreateForm(true)}
          >
            + New Token
          </button>
        )}
      </div>
      <p className="settings-description">
        Static bearer tokens for CLI tools, scripts, and other integrations.
        They work with MCP and the REST API, e.g.{' '}
        <code>curl -H "Authorization: Bearer &lt;token&gt;" {window.location.origin}/api/docs/&lt;docId&gt;/export?format=markdown</code>
      </p>

      {error && <div className="error">{error}</div>}

      {revealedToken && (
        <div className="api-token-reveal">
          <p className="api-token-reveal-warning">
            Copy this token now — you won't be able to see it again.
          </p>
          <code className="api-token-reveal-value">{revealedToken.token}</code>
          <div className="api-token-reveal-actions">
            <button className="btn-copy-token" onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button className="btn-done-token" onClick={handleDismissReveal}>
              Done
            </button>
          </div>
        </div>
      )}

      {showCreateForm && (
        <form className="api-token-create-form" onSubmit={handleCreate}>
          <input
            type="text"
            placeholder="Token name (e.g., CLI tool)"
            value={newTokenName}
            onChange={(e) => setNewTokenName(e.target.value)}
            maxLength={255}
            autoFocus
            disabled={creating}
          />
          <button type="submit" disabled={creating || !newTokenName.trim()}>
            {creating ? 'Creating...' : 'Create'}
          </button>
          <button type="button" onClick={() => { setShowCreateForm(false); setNewTokenName(''); }}>
            Cancel
          </button>
        </form>
      )}

      {tokens.length === 0 && !revealedToken ? (
        <p className="settings-empty-text">No API tokens yet. Create one to use with CLI tools or scripts.</p>
      ) : (
        <ul className="api-token-list">
          {tokens.map(token => (
            <li key={token.id} className="api-token-card">
              <div className="api-token-header">
                <div className="api-token-info">
                  <strong>{token.name}</strong>
                  <code className="api-token-prefix">{token.tokenPrefix}...</code>
                </div>
                <button
                  className="btn-revoke"
                  onClick={() => handleRevoke(token.id, token.name)}
                >
                  Revoke
                </button>
              </div>
              <div className="api-token-meta">
                <span>{token.scopes.join(', ')}</span>
                <span>Created {formatTimeAgo(token.createdAt)}</span>
                <span>
                  {token.lastUsedAt
                    ? `Last used ${formatTimeAgo(token.lastUsedAt)}`
                    : 'Never used'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
