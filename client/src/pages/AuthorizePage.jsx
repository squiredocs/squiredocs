/**
 * Agent Authorization Consent Page
 *
 * Displays agent info and requested permissions, allowing user to approve/deny.
 */
import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

const SCOPE_DESCRIPTIONS = {
  'documents:read': {
    label: 'Read your documents',
    description: 'View document titles, content, and metadata',
    icon: '📖',
  },
  'documents:write': {
    label: 'Edit your documents',
    description: 'Create, modify, and delete documents on your behalf',
    icon: '✏️',
  },
};

export default function AuthorizePage() {
  const { user, isAuthenticated, loading: authLoading, api } = useAuth();

  const [agentInfo, setAgentInfo] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Parse query parameters
  const params = new URLSearchParams(window.location.search);
  const agentClientId = params.get('agent_client_id');
  const scopes = params.get('scope')?.split(' ') || [];
  const redirectUri = params.get('redirect_uri');
  const state = params.get('state');
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method');
  const agentInstanceId = params.get('agent_instance_id');
  const existingDelegation = params.get('existing_delegation') === 'true';

  useEffect(() => {
    if (!agentClientId) {
      setError('Missing agent_client_id parameter');
      setIsLoading(false);
      return;
    }

    // Fetch agent info
    fetch(`/mcp/auth/agents/${agentClientId}`)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setError(data.error);
        } else {
          setAgentInfo(data);
        }
      })
      .catch(err => setError('Failed to load agent information'))
      .finally(() => setIsLoading(false));
  }, [agentClientId]);

  const handleDecision = async (approved) => {
    setIsSubmitting(true);

    try {
      const response = await api.post('/mcp/auth/approve', {
        agent_client_id: agentClientId,
        agent_instance_id: agentInstanceId,
        scopes: scopes,
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        approved,
      });

      // Check if server returned a redirect URL
      if (response.data.redirectUrl) {
        // If opened in a popup, extract code and send to parent
        if (window.opener && !window.opener.closed) {
          try {
            const url = new URL(response.data.redirectUrl);
            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');

            if (code) {
              // Send code to parent window via postMessage
              window.opener.postMessage({
                type: 'oauth_callback',
                code: code,
                state: state
              }, window.location.origin);

              // Show success message and close popup
              setError('success');
              setIsSubmitting(false);

              // Close popup after a short delay
              setTimeout(() => {
                window.close();
              }, 1500);

              return;
            }
          } catch (err) {
            console.error('Failed to send message to parent:', err);
          }
        }

        // Fallback: navigate to the callback URL
        window.location.href = response.data.redirectUrl;
      } else if (response.data.error) {
        setError(response.data.error);
      }
    } catch (err) {
      console.error('Authorization error:', err);
      if (err.response?.data?.error) {
        setError(err.response.data.error);
      } else {
        setError(`Failed to process authorization: ${err.message}`);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (authLoading || isLoading) {
    return (
      <div className="auth-page">
        <div className="auth-card loading">
          <div className="spinner" />
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h2>Sign in required</h2>
          <p>Please sign in to authorize this application.</p>
          <a href={`/login?returnTo=${encodeURIComponent(window.location.href)}`}>
            Sign in with Google
          </a>
        </div>
      </div>
    );
  }

  if (error) {
    const isSuccess = error === 'success';
    return (
      <div className="auth-page">
        <div className={`auth-card ${isSuccess ? 'success' : 'error'}`}>
          <h2>{isSuccess ? '✅ Success!' : 'Authorization Error'}</h2>
          <p>{isSuccess ? 'Authorization approved! This window will close automatically.' : error}</p>
          {!isSuccess && <button onClick={() => window.close()}>Close</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="agent-header">
          {agentInfo?.iconUrl ? (
            <img src={agentInfo.iconUrl} alt="" className="agent-icon" />
          ) : (
            <div className="agent-icon default">🤖</div>
          )}
          <h2>{agentInfo?.name || agentClientId}</h2>
          {agentInfo?.description && (
            <p className="agent-description">{agentInfo.description}</p>
          )}
        </div>

        <div className="consent-section">
          <p className="consent-prompt">
            <strong>{agentInfo?.name}</strong> wants to access your account
          </p>

          <div className="permissions-list">
            <h3>This will allow the application to:</h3>
            <ul>
              {scopes.map(scope => {
                const info = SCOPE_DESCRIPTIONS[scope] || {
                  label: scope,
                  description: '',
                  icon: '🔐'
                };
                return (
                  <li key={scope}>
                    <span className="scope-icon">{info.icon}</span>
                    <div className="scope-details">
                      <strong>{info.label}</strong>
                      {info.description && <p>{info.description}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {redirectUri && (
            <div className="redirect-info">
              <h3>Will redirect to:</h3>
              <code className="redirect-uri">{redirectUri}</code>
              {!redirectUri.startsWith('http://localhost') &&
               !redirectUri.startsWith('http://127.0.0.1') &&
               !redirectUri.startsWith('http://[::1]') && (
                <p className="redirect-warning">
                  This is an external URL. Only approve if you trust this application.
                </p>
              )}
            </div>
          )}

          {existingDelegation && (
            <div className="existing-warning">
              <p>You've previously authorized this application.
                 Approving will update the permissions.</p>
            </div>
          )}

          <div className="user-info">
            <p>Signed in as <strong>{user.email}</strong></p>
          </div>
        </div>

        <div className="button-group">
          <button
            className="btn-deny"
            onClick={() => handleDecision(false)}
            disabled={isSubmitting}
          >
            Deny
          </button>
          <button
            className="btn-approve"
            onClick={() => handleDecision(true)}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Authorizing...' : 'Authorize'}
          </button>
        </div>
      </div>
    </div>
  );
}
