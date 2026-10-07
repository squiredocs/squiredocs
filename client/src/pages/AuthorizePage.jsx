/**
 * Agent Authorization Consent Page
 *
 * Displays agent info and requested permissions, allowing user to approve/deny.
 */
import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import Logo from '../components/Logo';
import { CLAIM_COMMAND } from '../components/LoginPage';
import useAuthProviders from '../hooks/useAuthProviders';
import '../components/LoginPage.css';

const GOOGLE_PROVIDER = { id: 'google', label: 'Google', startPath: '/auth/google' };

const SCOPE_DESCRIPTIONS = {
  'documents:read': {
    label: 'Read your Squire Docs documents',
    description: 'View titles, content, and metadata of documents in your Squire Docs account',
  },
  'documents:write': {
    label: 'Edit your Squire Docs documents',
    description: 'Create, modify, and delete documents in your Squire Docs account',
  },
};

function CheckGlyph({ size = 12 }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" width={size} height={size} aria-hidden="true">
      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
    </svg>
  );
}

/** Simple centered shell for loading / sign-in / terminal states. */
function AuthorizeShell({ children, bare = false }) {
  const card = (
    <div className="login-container authorize-container">
      <div className="login-branding">
        <div className="login-logo"><Logo color="currentColor" /></div>
        <h1 className="login-title">Squire Docs</h1>
      </div>
      {children}
    </div>
  );
  // `bare` renders just the card (no full-height centering wrapper) so several
  // surfaces can be stacked — used by /authorize-preview.
  return bare ? card : <div className="login-page">{card}</div>;
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
  bare = false,
}) {
  const isLocalRedirect = redirectUri &&
    (redirectUri.startsWith('http://localhost') ||
     redirectUri.startsWith('http://127.0.0.1') ||
     redirectUri.startsWith('http://[::1]'));

  // Mirror the first-run surface (FirstRunConsent): same Squire Docs branding
  // shell, heading, lead, and bordered grant box — so the returning-user consent
  // reads as the same product, not a separate screen. Keeps its functional bits:
  // per-scope permission detail, signed-in/redirect meta, and Deny/Authorize.
  return (
    <AuthorizeShell bare={bare}>
      <h2 className="login-headline">Authorize {agentName}</h2>
      <p className="authorize-firstrun-lead">
        {agentName} is asking to connect to your Squire Docs account.
        {existingDelegation ? " You've connected it before — approving updates its access." : ''}
      </p>

      <div className="authorize-firstrun-grant">
        <p className="authorize-firstrun-grant-lead">
          This grants {agentName} access to your Squire Docs account. It will be
          able to:
        </p>
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
        <p className="authorize-firstrun-revoke">
          You can revoke this access anytime in Settings &rarr; AI Agent Access.
        </p>
      </div>

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
    </AuthorizeShell>
  );
}

/**
 * The first-run single-consent surface (feature 031). Rendered live for an
 * unauthenticated /authorize visitor AND in the /authorize-preview route so the
 * copy can be reviewed without a real OAuth request. Transparency (grant +
 * revocation) is PRIMARY; the value reminder is SECONDARY.
 */
//
// Feature 059 (FR-018, RBD-059-9): the lead, the grant tail, and the action come
// from the instance's provider. Team mode with Google renders exactly the
// pre-059 copy (pinned by LoginPage.baseline.test.jsx); `localMode` replaces
// the action with the sign-in-link instruction and names no provider.
export function FirstRunConsent({
  agentName = 'Your agent',
  scopes = [],
  href = '#',
  bare = false,
  provider = GOOGLE_PROVIDER,
  localMode = false,
}) {
  const grant = scopes.includes('documents:write')
    ? 'read, create, edit, and delete the documents in your Squire Docs account'
    : 'read the documents in your Squire Docs account';
  const providerAccount = provider.label === 'Google' ? 'Google Account' : `${provider.label} account`;
  return (
    <AuthorizeShell bare={bare}>
      <h2 className="login-headline">Connect to Squire Docs</h2>

      <p className="authorize-firstrun-lead">
        {localMode
          ? <>Sign in to this Squire Docs instance to connect {agentName}.</>
          : <>Sign in to Squire Docs with your {providerAccount} to connect {agentName}.</>}
      </p>

      {/* Value reminder (the hook). */}
      <ul className="authorize-firstrun-points">
        <li>One place where humans and coding agents write the same spec together.</li>
        <li>
          A spec your agents can work with and your team can review — with
          two-way sync to the markdown in your repo.
        </li>
        <li>Every edit is attributed to human or agent, and revertible.</li>
      </ul>

      {/* Transparency: the grant + revocation sit immediately above the action,
          so the user reads exactly what they are granting right before acting. */}
      <div className="authorize-firstrun-grant">
        <p className="authorize-firstrun-grant-lead">
          {localMode ? (
            <>This grants {agentName} access to your Squire Docs account. Once connected, it will be able to {grant}.</>
          ) : (
            <>
              This grants {agentName} access to your Squire Docs account — not your
              {' '}{provider.label} account. Once connected, it will be able to {grant}.
            </>
          )}
        </p>
        <p className="authorize-firstrun-revoke">
          You can revoke this access anytime in Settings &rarr; AI Agent Access.
        </p>
      </div>

      {localMode ? (
        <div className="login-local">
          <p>This instance signs in with a one-time link. Run:</p>
          <code className="login-local-command">{CLAIM_COMMAND}</code>
          <p>Open the link it prints, then come back to {agentName} and try again; it reopens this page.</p>
        </div>
      ) : (
        <a href={href} className={`login-button ${provider.id}-button authorize-signin-link`}>
          Continue with {provider.label}
        </a>
      )}
    </AuthorizeShell>
  );
}

export function AuthorizePreview() {
  // Preview both first-run surfaces (the new single-screen copy, write + read
  // scope) and the returning-user ConsentCard. Visit /authorize-preview.
  return (
    <div className="authorize-preview-stack">
      <FirstRunConsent bare agentName="Claude Code" scopes={['documents:read', 'documents:write']} />
      {/* Feature 059: the local-mode first-run surface (no provider). */}
      <FirstRunConsent bare localMode agentName="Claude Code" scopes={['documents:read', 'documents:write']} />
      <ConsentCard
        bare
        agentName="Claude Code"
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
  const { status: providersStatus, info: providerInfo } = useAuthProviders();

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
    // Feature 031 — First-run consent collapse: the SOLE consent surface a
    // first-run user sees (no separate ConsentCard). Rendered via the shared
    // FirstRunConsent component (also used by /authorize-preview). "Continue
    // with Google" goes STRAIGHT to Google (no /login hop, FR-001/C1).
    // Feature 059: the action and its start path come from the provider
    // registry; a local instance shows the sign-in-link instruction instead.
    if (providersStatus === 'loading') {
      return (
        <AuthorizeShell>
          <p className="authorize-loading-text">Loading...</p>
        </AuthorizeShell>
      );
    }
    const who = agentInfo?.name || 'Your agent';
    if (providerInfo.mode === 'local' || providerInfo.providers.length === 0) {
      return <FirstRunConsent agentName={who} scopes={scopes} localMode />;
    }
    const provider = providerInfo.providers[0];
    const href = `${provider.startPath}?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    return <FirstRunConsent agentName={who} scopes={scopes} href={href} provider={provider} />;
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
  );
}
