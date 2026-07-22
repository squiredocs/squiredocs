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

function AgentGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="26" height="26" aria-hidden="true">
      <rect x="3" y="4" width="18" height="14" rx="3" />
      <circle cx="9" cy="11" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="15" cy="11" r="1.5" fill="currentColor" stroke="none" />
      <path d="M7 2v3M17 2v3" strokeLinecap="round" />
    </svg>
  );
}

function CheckGlyph({ size = 12 }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" width={size} height={size} aria-hidden="true">
      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
    </svg>
  );
}

/**
 * Agent-tile ⋯ ✓ ⋯ Squire-tile connection row — the identity header for
 * every consent state, in place of the stacked login branding block.
 */
function IdentityRow({ iconUrl }) {
  return (
    <div className="authorize-identity">
      <div className="authorize-identity-tile authorize-identity-agent">
        {iconUrl ? <img src={iconUrl} alt="" /> : <AgentGlyph />}
      </div>
      <div className="authorize-connector" aria-hidden="true">
        <span className="authorize-connector-line" />
        <span className="authorize-connector-check"><CheckGlyph /></span>
        <span className="authorize-connector-line" />
      </div>
      <div className="authorize-identity-tile" title="Squire Docs">
        <Logo color="#7c3aed" size={30} />
      </div>
    </div>
  );
}

/** Simple centered shell for loading / sign-in / terminal states. */
function AuthorizeShell({ children }) {
  return (
    <div className="login-page">
      <div className="login-container authorize-container">
        <div className="login-branding">
          <div className="login-logo"><Logo color="currentColor" /></div>
          <h1 className="login-title">Squire Docs</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

function ConsentCard({
  agentName,
  agentDescription,
  iconUrl,
  scopes,
  redirectUri,
  userEmail,
  existingDelegation,
  isSubmitting,
  onDecision,
}) {
  const isLocalRedirect = redirectUri &&
    (redirectUri.startsWith('http://localhost') ||
     redirectUri.startsWith('http://127.0.0.1') ||
     redirectUri.startsWith('http://[::1]'));

  return (
    <div className="login-container authorize-container">
      <IdentityRow iconUrl={iconUrl} />

      <h1 className="authorize-headline">Authorize {agentName}</h1>
      <p className="authorize-subtitle">
        {agentDescription || 'This agent is requesting access to your Squire Docs account.'}
      </p>

      <div className="authorize-permissions">
        <h2 className="authorize-permissions-heading">{agentName} will be able to</h2>
        <ul className="authorize-permissions-list">
          {scopes.map(scope => {
            const info = SCOPE_DESCRIPTIONS[scope] || { label: scope, description: '' };
            return (
              <li key={scope} className="authorize-permission-item">
                <span className="authorize-permission-check"><CheckGlyph size={13} /></span>
                <div>
                  <strong>{info.label}</strong>
                  {info.description && <p>{info.description}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {existingDelegation && (
        <p className="authorize-existing-note">
          You've authorized {agentName} before — approving updates its permissions.
        </p>
      )}

      <dl className="authorize-meta">
        <div className="authorize-meta-row">
          <dt>Signed in as</dt>
          <dd>{userEmail}</dd>
        </div>
        {redirectUri && (
          <div className="authorize-meta-row">
            <dt>Redirects to</dt>
            <dd><code>{redirectUri}</code></dd>
          </div>
        )}
      </dl>

      {redirectUri && !isLocalRedirect && (
        <p className="authorize-redirect-warning">
          This redirect goes to an external URL. Only approve if you trust this application.
        </p>
      )}

      <div className="authorize-buttons">
        <button
          className="authorize-deny-btn"
          onClick={() => onDecision(false)}
          disabled={isSubmitting}
        >
          Deny
        </button>
        <button
          className="login-button authorize-approve-btn"
          onClick={() => onDecision(true)}
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Authorizing...' : 'Authorize'}
        </button>
      </div>

      <p className="authorize-revoke-note">
        Revoke access anytime in Settings &rarr; AI Agent Access.
      </p>
    </div>
  );
}

export function AuthorizePreview() {
  return (
    <div className="login-page">
      <ConsentCard
        agentName="Claude Desktop"
        agentDescription="AI assistant for document editing"
        iconUrl={null}
        scopes={['documents:read', 'documents:write']}
        redirectUri="http://localhost:3000/callback"
        userEmail="user@example.com"
        existingDelegation={false}
        isSubmitting={false}
        onDecision={() => {}}
      />
    </div>
  );
}

export default function AuthorizePage() {
  const { user, isAuthenticated, loading: authLoading, api } = useAuth();

  const [agentInfo, setAgentInfo] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
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
              setSuccess(true);
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
      <AuthorizeShell>
        <p className="authorize-loading-text">Loading...</p>
      </AuthorizeShell>
    );
  }

  if (!isAuthenticated) {
    // Describe the ask by the scopes actually requested — a read-only agent
    // (documents:read without documents:write) cannot create or sync (030 review).
    const ask = scopes.includes('documents:write')
      ? 'create and sync documents'
      : 'read documents';
    const who = agentInfo?.name || 'Your agent';
    const agentAsk = `${who} wants to ${ask} in your Squire Docs account.`;
    return (
      <AuthorizeShell>
        <h2 className="login-headline">Connect to Squire Docs</h2>
        <p className="authorize-firstrun-lead">
          Continue with Google to authorize this connection. If you've never used
          Squire Docs, that same click creates your account — there's no separate
          signup step.
        </p>
        <ul className="authorize-firstrun-points">
          <li>
            Squire Docs is the durable, attributed spec layer for agentic
            development — your spec, design, and status in one shared doc.
          </li>
          <li>{agentAsk}</li>
          <li>
            Every agent edit is attributed and revertible, so you always see who
            changed what.
          </li>
        </ul>
        <a
          href={`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`}
          className="login-button google-button authorize-signin-link"
        >
          Continue with Google
        </a>
      </AuthorizeShell>
    );
  }

  if (success) {
    return (
      <div className="login-page">
        <div className="login-container authorize-container">
          <div className="authorize-success-icon"><CheckGlyph size={22} /></div>
          <h1 className="authorize-headline">Authorized</h1>
          <p className="authorize-subtitle">This window will close automatically.</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <AuthorizeShell>
        <h2 className="login-headline">Authorization Error</h2>
        <div className="login-error">{error}</div>
        <button className="authorize-close-btn" onClick={() => window.close()}>Close</button>
      </AuthorizeShell>
    );
  }

  return (
    <div className="login-page">
      <ConsentCard
        agentName={agentInfo?.name || agentClientId}
        agentDescription={agentInfo?.description}
        iconUrl={agentInfo?.iconUrl}
        scopes={scopes}
        redirectUri={redirectUri}
        userEmail={user.email}
        existingDelegation={existingDelegation}
        isSubmitting={isSubmitting}
        onDecision={handleDecision}
      />
    </div>
  );
}
