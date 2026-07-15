/**
 * MCP login activation / consent page (feature 008-mcp-login-bootstrap).
 *
 * The browser half of the login bootstrap. Mirrors AuthorizePage's login
 * round-trip and visual language, but drives the login flow's own routes:
 *   1. signed out  → sign-in prompt (feature-005 returnTo round-trip)
 *   2. code entry  → POST /mcp/login/code  (server normalization is authoritative)
 *   3. consent     → skeptical, self-declared-name card
 *   4. decision    → POST /mcp/login/decision → result state
 *
 * The agent's self-declared name is hostile input: it is rendered ONLY as a
 * React text node (inert by construction) — never via dangerouslySetInnerHTML.
 */
import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import Logo from '../components/Logo';
import '../components/LoginPage.css';

// Same copy as AuthorizePage's consent card.
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

function CheckGlyph({ size = 12 }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" width={size} height={size} aria-hidden="true">
      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
    </svg>
  );
}

/** Simple centered shell for loading / sign-in / result states. */
function ActivateShell({ children }) {
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

// Cosmetic-only normalization for the input (server re-normalizes authoritatively):
// uppercase, keep only alphanumerics, regroup as XXXX-XXXX.
function formatCodeInput(raw) {
  const bare = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return bare.length > 4 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : bare;
}

export default function ActivatePage() {
  const { user, isAuthenticated, loading: authLoading, api } = useAuth();

  const [code, setCode] = useState('');
  const [step, setStep] = useState('code'); // 'code' | 'consent' | 'result'
  const [consent, setConsent] = useState(null); // { authorizationId, agentName, scopes }
  const [result, setResult] = useState(null); // { kind, ... }
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (authLoading) {
    return (
      <ActivateShell>
        <p className="authorize-loading-text">Loading…</p>
      </ActivateShell>
    );
  }

  if (!isAuthenticated) {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    return (
      <ActivateShell>
        <h2 className="login-headline">Sign in to continue</h2>
        <p className="authorize-subtitle">
          Sign in to review and approve the agent that asked you to open this page.
        </p>
        <a
          href={`/login?returnTo=${returnTo}`}
          className="login-button google-button authorize-signin-link"
        >
          Sign in with Google
        </a>
      </ActivateShell>
    );
  }

  const submitCode = async (e) => {
    if (e) e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const res = await api.post('/mcp/login/code', { code: code.trim() });
      setConsent({
        authorizationId: res.data.authorizationId,
        agentName: res.data.agentName,
        scopes: res.data.scopes || [],
      });
      setStep('consent');
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
      } else {
        setError('That code is invalid or has expired. Ask your agent to run login again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const decide = async (approved) => {
    setError(null);
    setIsSubmitting(true);
    try {
      const res = await api.post('/mcp/login/decision', {
        authorizationId: consent.authorizationId,
        approved,
      });
      setResult({ kind: res.data.status === 'denied' ? 'denied' : 'approved' });
      setStep('result');
    } catch (err) {
      const status = err.response?.status;
      if (status === 410) {
        setResult({ kind: 'expired' });
      } else if (status === 409) {
        setResult({ kind: 'token_limit' });
      } else {
        setResult({ kind: 'invalid' });
      }
      setStep('result');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (step === 'result') {
    return <ResultView kind={result.kind} />;
  }

  if (step === 'consent' && consent) {
    return (
      <div className="login-page">
        <div className="login-container authorize-container">
          <h1 className="authorize-headline">Approve this agent?</h1>
          <p className="authorize-subtitle">
            {'An agent calling itself “'}
            <strong>{consent.agentName}</strong>
            {'” requests access to your documents.'}
          </p>
          <p className="authorize-redirect-warning">
            This name is self-declared and has NOT been verified. Approve only if you started this
            and recognize the agent.
          </p>

          <div className="authorize-permissions">
            <h2 className="authorize-permissions-heading">It will be able to</h2>
            <ul className="authorize-permissions-list">
              {consent.scopes.map((scope) => {
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

          <dl className="authorize-meta">
            <div className="authorize-meta-row">
              <dt>Signed in as</dt>
              <dd>{user.email}</dd>
            </div>
          </dl>

          {error && <div className="login-error">{error}</div>}

          <div className="authorize-buttons">
            <button className="authorize-deny-btn" onClick={() => decide(false)} disabled={isSubmitting}>
              Deny
            </button>
            <button
              className="login-button authorize-approve-btn"
              onClick={() => decide(true)}
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Working…' : 'Approve'}
            </button>
          </div>

          <p className="authorize-revoke-note">
            You can revoke this access anytime in Settings &rarr; AI Agent Access.
          </p>
        </div>
      </div>
    );
  }

  // step === 'code'
  return (
    <ActivateShell>
      <h2 className="login-headline">Enter your code</h2>
      <p className="authorize-subtitle">
        Enter the code your agent gave you to connect it to your Squire Docs account.
      </p>
      <form onSubmit={submitCode}>
        <input
          className="login-input activate-code-input"
          type="text"
          inputMode="text"
          autoComplete="one-time-code"
          aria-label="Activation code"
          placeholder="XXXX-XXXX"
          value={code}
          onChange={(e) => setCode(formatCodeInput(e.target.value))}
        />
        {error && <div className="login-error">{error}</div>}
        <button
          type="submit"
          className="login-button"
          disabled={isSubmitting || code.replace(/[^A-Z0-9]/gi, '').length < 8}
        >
          {isSubmitting ? 'Checking…' : 'Continue'}
        </button>
      </form>
      <dl className="authorize-meta">
        <div className="authorize-meta-row">
          <dt>Signed in as</dt>
          <dd>{user.email}</dd>
        </div>
      </dl>
    </ActivateShell>
  );
}

function ResultView({ kind }) {
  const content = {
    approved: {
      headline: 'Agent connected',
      body: 'The agent can now connect. Manage or revoke this access anytime in Settings → AI Agent Access.',
    },
    denied: {
      headline: 'Request denied',
      body: 'Nothing was granted.',
    },
    expired: {
      headline: 'Request expired',
      body: 'This request expired — ask your agent to log in again.',
    },
    token_limit: {
      headline: 'Token limit reached',
      body: "You've reached your API-token limit. Revoke a token in Settings → API Tokens, then ask your agent to log in again.",
    },
    invalid: {
      headline: 'Something went wrong',
      body: 'That request is invalid or has expired. Ask your agent to run login again.',
    },
  }[kind] || { headline: 'Something went wrong', body: 'Ask your agent to run login again.' };

  return (
    <div className="login-page">
      <div className="login-container authorize-container">
        {kind === 'approved' && (
          <div className="authorize-success-icon"><CheckGlyph size={22} /></div>
        )}
        <h1 className="authorize-headline">{content.headline}</h1>
        <p className="authorize-subtitle">{content.body}</p>
      </div>
    </div>
  );
}
