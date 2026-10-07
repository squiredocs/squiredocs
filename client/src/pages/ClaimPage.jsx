/**
 * The claim page, /claim#<token> (feature 059, FR-028, RBD-059-5, RBD-059-20,
 * contracts/pages.md).
 *
 * The token arrives only in the URL fragment, which browsers never send to a
 * server or put in a Referer. The page reads it once, removes it from the
 * address bar and history, asks the server what the link is (POST
 * /auth/signin-link/peek, which spends nothing), and renders:
 *
 *   claim link   "Create the owner account" with name and email prefilled
 *   signin link  "Sign in as <name> (<email>)" and Continue
 *   invalid      the expired-or-used message, no form
 *
 * Continue submits a real HTML form (POST /auth/signin-link), so the server's
 * redirect drives navigation exactly like the Google callback does.
 */
import { useEffect, useState } from 'react';
import Logo from '../components/Logo';
import { CLAIM_COMMAND, LINK_ERROR_MESSAGES } from '../components/LoginPage';
import '../components/LoginPage.css';
import './ClaimPage.css';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readTokenOnce() {
  const hash = window.location.hash || '';
  const token = hash.startsWith('#') ? hash.slice(1) : '';
  if (hash) {
    // Drop the fragment from the address bar and the history entry.
    window.history.replaceState(null, '', '/claim');
  }
  return TOKEN_RE.test(token) ? token : null;
}

function Shell({ children }) {
  return (
    <div className="login-page">
      <div className="login-container claim-container">
        <div className="login-branding">
          <div className="login-logo"><Logo color="currentColor" /></div>
          <h1 className="login-title">Squire Docs</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function ClaimPage() {
  const [token] = useState(readTokenOnce);
  const [errorParam] = useState(() => new URLSearchParams(window.location.search).get('error'));
  const [state, setState] = useState(token ? { status: 'peeking' } : { status: 'no-token' });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState(null);
  // Set once a form posts, so a double click cannot spend the link twice and
  // land a signed-in owner on a "link expired" page (059 review L2).
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    fetch('/auth/signin-link/peek', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token }),
    })
      .then((res) => res.json())
      .then((body) => {
        if (cancelled) return;
        if (!body || body.valid !== true) {
          setState({ status: 'invalid' });
          return;
        }
        setState({ status: 'valid', kind: body.kind, prefill: body.prefill || {} });
        if (body.kind === 'claim') {
          setName(body.prefill?.name || '');
          setEmail(body.prefill?.email || '');
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'invalid' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const onSubmit = (e) => {
    if (submitting) {
      e.preventDefault();
      return;
    }
    if (state.kind === 'claim') {
      if (!name.trim()) {
        e.preventDefault();
        setFieldError('name');
        return;
      }
      if (!EMAIL_RE.test(email.trim())) {
        e.preventDefault();
        setFieldError('email');
        return;
      }
    }
    setSubmitting(true);
  };

  if (state.status === 'no-token') {
    return (
      <Shell>
        <h2 className="login-headline">Sign in</h2>
        {errorParam === 'claim_invalid' ? (
          <p className="claim-text">Enter a name and a valid email address, then open the link from your terminal again.</p>
        ) : (
          <p className="claim-text">Open the link printed by <code>{CLAIM_COMMAND}</code>.</p>
        )}
      </Shell>
    );
  }

  if (state.status === 'peeking') {
    return (
      <Shell>
        <p className="claim-text">Checking your link...</p>
      </Shell>
    );
  }

  if (state.status === 'invalid') {
    return (
      <Shell>
        <h2 className="login-headline">Sign in</h2>
        <div className="login-error">{LINK_ERROR_MESSAGES.link_invalid}</div>
      </Shell>
    );
  }

  if (state.kind === 'signin') {
    return (
      <Shell>
        <h2 className="login-headline">Sign in</h2>
        <p className="claim-text">Sign in as {state.prefill.name} ({state.prefill.email})</p>
        <form method="post" action="/auth/signin-link" onSubmit={onSubmit}>
          <input type="hidden" name="token" value={token} />
          <button type="submit" className="login-button claim-continue" disabled={submitting}>Continue</button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      <h2 className="login-headline">Create the owner account</h2>
      <p className="claim-text">This account owns this Squire Docs instance. Your email is not verified or emailed.</p>
      {fieldError && <div className="login-error">{LINK_ERROR_MESSAGES.claim_invalid}</div>}
      <form method="post" action="/auth/signin-link" onSubmit={onSubmit} noValidate className="claim-form">
        <input type="hidden" name="token" value={token} />
        <label className="claim-field">
          <span>Name</span>
          <input
            name="name"
            type="text"
            value={name}
            maxLength={255}
            autoComplete="name"
            required
            aria-invalid={fieldError === 'name' || undefined}
            onChange={(e) => { setName(e.target.value); setFieldError(null); }}
          />
        </label>
        <label className="claim-field">
          <span>Email</span>
          <input
            name="email"
            type="email"
            value={email}
            maxLength={255}
            autoComplete="email"
            required
            aria-invalid={fieldError === 'email' || undefined}
            onChange={(e) => { setEmail(e.target.value); setFieldError(null); }}
          />
        </label>
        <button type="submit" className="login-button claim-continue" disabled={submitting}>Continue</button>
      </form>
    </Shell>
  );
}
