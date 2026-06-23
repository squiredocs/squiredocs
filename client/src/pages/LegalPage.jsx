/**
 * LegalPage — shared layout for the public legal documents
 * (Privacy Policy and Terms of Service).
 *
 * Renders a simple branded header, a readable content column, and a small
 * cross-link footer. The pages are public (no auth required) and are routed
 * in App.jsx before the authentication gate.
 */
import Logo from '../components/Logo';
import './LegalPage.css';

export default function LegalPage({ title, lastUpdated, children }) {
  return (
    <div className="legal-page">
      <header className="legal-header">
        <a href="/" className="legal-logo-link">
          <span className="legal-logo">
            <Logo color="currentColor" />
          </span>
          <span className="legal-brand">Squire Docs</span>
        </a>
      </header>

      <main className="legal-content">
        <h1 className="legal-title">{title}</h1>
        <p className="legal-updated">Last updated: {lastUpdated}</p>

        <div className="legal-body">
          {children}
        </div>

        <nav className="legal-footer-nav" aria-label="Legal">
          <a href="/privacy">Privacy Policy</a>
          <span className="legal-footer-sep" aria-hidden="true">·</span>
          <a href="/terms">Terms of Service</a>
          <span className="legal-footer-sep" aria-hidden="true">·</span>
          <a href="/login">Sign in</a>
        </nav>
      </main>
    </div>
  );
}
