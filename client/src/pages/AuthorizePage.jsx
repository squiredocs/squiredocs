/**
 * Agent Authorization Consent Page
 *
 * Displays agent info and requested permissions, allowing user to approve/deny.
 */
import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import Logo from '../components/Logo';
import '../components/LoginPage.css';

const SCOPE_DESCRIPTIONS = {
  'documents:read': {
    label: 'Read your documents',
    description: 'View document titles, content, and metadata',
  },
  'documents:write': {
    label: 'Edit your documents',
    description: 'Create, modify, and delete documents on your behalf',
  },
};

export function AuthorizePreview() {
  const preview = {
    user: { email: 'user@example.com' },
    agentInfo: { name: 'Claude Desktop', description: 'AI assistant for document editing' },
    scopes: ['documents:read', 'documents:write'],
    redirectUri: 'http://localhost:3000/callback',
    existingDelegation: false,
    isSubmitting: false,
  };

  return (
    <div className="login-page">
      <div className="login-container authorize-container">
        <div className="login-branding">
          <div className="login-logo"><Logo color="currentColor" /></div>
          <h1 className="login-title">Squire Docs</h1>
        </div>

        <div className="authorize-agent-header">
          <div className="authorize-agent-icon authorize-agent-icon-default">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="28" height="28">
              <rect x="3" y="4" width="18" height="14" rx="3" />
              <circle cx="9" cy="11" r="1.5" fill="currentColor" stroke="none" />
              <circle cx="15" cy="11" r="1.5" fill="currentColor" stroke="none" />
              <path d="M7 2v3M17 2v3" strokeLinecap="round" />
            </svg>
          </div>
          <h3 className="authorize-agent-name">{preview.agentInfo.name}</h3>
          <p className="authorize-agent-desc">{preview.agentInfo.description}</p>
        </div>

        <p className="authorize-prompt">
          <strong>{preview.agentInfo.name}</strong> wants to access your account
        </p>

        <div className="authorize-permissions">
          <h4 className="authorize-permissions-heading">This will allow the application to:</h4>
          <ul className="authorize-permissions-list">
            {preview.scopes.map(scope => {
              const info = SCOPE_DESCRIPTIONS[scope] || { label: scope, description: '' };
              return (
                <li key={scope} className="authorize-permission-item">
                  <svg className="authorize-permission-check" viewBox="0 0 20 20" fill="#7c3aed" width="18" height="18">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  <div>
                    <strong>{info.label}</strong>
                    {info.description && <p>{info.description}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="authorize-redirect">
          <code>{preview.redirectUri}</code>
        </div>

        <div className="login-footer" style={{ borderTop: 'none', paddingTop: 0 }}>
          <p className="authorize-signed-in">Signed in as <strong>{preview.user.email}</strong></p>
        </div>

        <div className="authorize-buttons">
          <button className="authorize-deny-btn" disabled={preview.isSubmitting}>Deny</button>
          <button className="login-button authorize-approve-btn" disabled={preview.isSubmitting}>Authorize</button>
        </div>
      </div>
    </div>
  );
}

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
      <div className="login-page">
        <div className="login-container authorize-container">
          <div className="login-branding">
            <div className="login-logo"><Logo color="currentColor" /></div>
            <h1 className="login-title">Squire Docs</h1>
          </div>
          <p className="authorize-loading-text">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="login-page">
        <div className="login-container authorize-container">
          <div className="login-branding">
            <div className="login-logo"><Logo color="currentColor" /></div>
            <h1 className="login-title">Squire Docs</h1>
          </div>
          <h2 className="login-headline">Sign in required</h2>
          <p className="authorize-subtitle">Please sign in to authorize this application.</p>
          <a
            href={`/login?returnTo=${encodeURIComponent(window.location.href)}`}
            className="login-button google-button"
            style={{ textDecoration: 'none' }}
          >
            Sign in with Google
          </a>
        </div>
      </div>
    );
  }

  if (error) {
    const isSuccess = error === 'success';
    return (
      <div className="login-page">
        <div className="login-container authorize-container">
          <div className="login-branding">
            <div className="login-logo"><Logo color="currentColor" /></div>
            <h1 className="login-title">Squire Docs</h1>
          </div>
          {isSuccess ? (
            <>
              <h2 className="login-headline">Authorized</h2>
              <p className="authorize-success-text">Authorization approved! This window will close automatically.</p>
            </>
          ) : (
            <>
              <h2 className="login-headline">Authorization Error</h2>
              <div className="login-error">{error}</div>
              <button className="authorize-close-btn" onClick={() => window.close()}>Close</button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-container authorize-container">
        <div className="login-branding">
          <div className="login-logo"><Logo color="currentColor" /></div>
          <h1 className="login-title">Squire Docs</h1>
        </div>

        <div className="authorize-agent-header">
          {agentInfo?.iconUrl ? (
            <img src={agentInfo.iconUrl} alt="" className="authorize-agent-icon" />
          ) : (
            <div className="authorize-agent-icon authorize-agent-icon-default">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="28" height="28">
                <rect x="3" y="4" width="18" height="14" rx="3" />
                <circle cx="9" cy="11" r="1.5" fill="currentColor" stroke="none" />
                <circle cx="15" cy="11" r="1.5" fill="currentColor" stroke="none" />
                <path d="M7 2v3M17 2v3" strokeLinecap="round" />
              </svg>
            </div>
          )}
          <h3 className="authorize-agent-name">{agentInfo?.name || agentClientId}</h3>
          {agentInfo?.description && (
            <p className="authorize-agent-desc">{agentInfo.description}</p>
          )}
        </div>

        <p className="authorize-prompt">
          <strong>{agentInfo?.name}</strong> wants to access your account
        </p>

        <div className="authorize-permissions">
          <h4 className="authorize-permissions-heading">This will allow the application to:</h4>
          <ul className="authorize-permissions-list">
            {scopes.map(scope => {
              const info = SCOPE_DESCRIPTIONS[scope] || {
                label: scope,
                description: '',
              };
              return (
                <li key={scope} className="authorize-permission-item">
                  <svg className="authorize-permission-check" viewBox="0 0 20 20" fill="#7c3aed" width="18" height="18">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  <div>
                    <strong>{info.label}</strong>
                    {info.description && <p>{info.description}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {redirectUri && (
          <div className="authorize-redirect">
            <code>{redirectUri}</code>
            {!redirectUri.startsWith('http://localhost') &&
             !redirectUri.startsWith('http://127.0.0.1') &&
             !redirectUri.startsWith('http://[::1]') && (
              <p className="authorize-redirect-warning">
                This is an external URL. Only approve if you trust this application.
              </p>
            )}
          </div>
        )}

        {existingDelegation && (
          <div className="authorize-existing-warning">
            <p>You've previously authorized this application. Approving will update the permissions.</p>
          </div>
        )}

        <div className="login-footer" style={{ borderTop: 'none', paddingTop: 0 }}>
          <p className="authorize-signed-in">Signed in as <strong>{user.email}</strong></p>
        </div>

        <div className="authorize-buttons">
          <button
            className="authorize-deny-btn"
            onClick={() => handleDecision(false)}
            disabled={isSubmitting}
          >
            Deny
          </button>
          <button
            className="login-button authorize-approve-btn"
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
