import React, { useState, useEffect } from 'react';
import './LandingPage.css';

/**
 * Marketing landing page for HeroDocs
 * Displays value proposition, features, and waitlist signup
 */
export default function LandingPage({ isAuthenticated, onNavigateToDocs, onNavigateToLogin }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [orgSize, setOrgSize] = useState('');
  const [submitStatus, setSubmitStatus] = useState(null); // null, 'loading', 'success', 'error'
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    document.title = 'HeroDocs - AI-Native Collaborative Documents';
    
    return () => {
      document.title = 'HeroDocs';
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitStatus('loading');
    setErrorMessage('');

    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          role: role || undefined,
          org_size: orgSize || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to join waitlist');
      }

      setSubmitStatus('success');
      setEmail('');
      setRole('');
      setOrgSize('');
    } catch (error) {
      setSubmitStatus('error');
      setErrorMessage(error.message);
    }
  };

  const scrollToWaitlist = () => {
    document.getElementById('waitlist')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="landing-page">
      {/* Header */}
      <header className="landing-header">
        <div className="landing-header-content">
          <a href="/" className="landing-logo">
            <svg className="landing-logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <path d="M12 18v-6" />
              <path d="M9 15l3 3 3-3" />
            </svg>
            <span className="landing-logo-text">HeroDocs</span>
          </a>
          <nav className="landing-nav">
            {isAuthenticated ? (
              <button className="landing-nav-btn primary" onClick={onNavigateToDocs}>
                Go to Documents
              </button>
            ) : (
              <button className="landing-nav-btn" onClick={onNavigateToLogin}>
                Sign In
              </button>
            )}
          </nav>
        </div>
      </header>

      {/* Hero Section */}
      <section className="landing-hero">
        <div className="landing-hero-content">
          <h1 className="landing-headline">AI-Native Collaborative Documents</h1>
          <p className="landing-subheadline">Google Docs with a Built-In AI Project Manager</p>
          <p className="landing-value-prop">
            Teams generate effective, accurate documents 10x faster by eliminating coordination overhead
          </p>
          <div className="landing-hero-cta">
            <button className="landing-btn primary" onClick={scrollToWaitlist}>
              Join Waitlist
            </button>
          </div>
        </div>
      </section>

      {/* Problem Section */}
      <section className="landing-section problem">
        <div className="landing-section-content">
          <h2 className="landing-section-title">Every Collaborative Document Needs a Hero</h2>
          <p className="landing-section-text">
            Someone must manually coordinate contributors, chase input, synthesize responses,
            and keep documents synchronized with fragmented discussions. This coordination work
            consumes 60-80% of effort on high-stakes documents like RFPs, contracts, and proposals.
          </p>
        </div>
      </section>

      {/* Solution Section */}
      <section className="landing-section solution">
        <div className="landing-section-content">
          <h2 className="landing-section-title">HeroDocs = AI Project Manager for Documents</h2>
          <p className="landing-section-text">
            Combines real-time collaborative editing with intelligent AI orchestration
            that eliminates coordination overhead.
          </p>

          <div className="landing-features">
            <div className="landing-feature-card">
              <div className="landing-feature-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <h3 className="landing-feature-title">Coordinate Contributors</h3>
              <p className="landing-feature-text">
                AI identifies and prompts stakeholders with targeted questions—not generic "please review" requests.
              </p>
            </div>

            <div className="landing-feature-card">
              <div className="landing-feature-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
              </div>
              <h3 className="landing-feature-title">Synthesize Input</h3>
              <p className="landing-feature-text">
                AI proposes document updates based on collected input with transparent attribution. Human approval required.
              </p>
            </div>

            <div className="landing-feature-card">
              <div className="landing-feature-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <h3 className="landing-feature-title">Track Decisions</h3>
              <p className="landing-feature-text">
                Complete audit trail of all inputs, discussions, and resolutions. Searchable and exportable.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Social Proof Section */}
      <section className="landing-section social-proof">
        <div className="landing-section-content">
          <p className="landing-social-text">
            Currently working with design partners in consulting, legal, and grant writing
          </p>
        </div>
      </section>

      {/* Waitlist Section */}
      <section className="landing-section waitlist" id="waitlist">
        <div className="landing-section-content">
          <h2 className="landing-section-title">Join the Waitlist</h2>
          <p className="landing-section-text">
            Be the first to know when HeroDocs is ready.
          </p>

          {submitStatus === 'success' ? (
            <div className="landing-form-success">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <p>You're on the list! We'll be in touch soon.</p>
            </div>
          ) : (
            <form className="landing-form" onSubmit={handleSubmit}>
              <div className="landing-form-row">
                <input
                  type="email"
                  placeholder="Email address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="landing-input"
                />
              </div>

              <div className="landing-form-row optional">
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="landing-select"
                >
                  <option value="">Role (optional)</option>
                  <option value="consultant">Consultant</option>
                  <option value="legal">Legal Professional</option>
                  <option value="grant_writer">Grant Writer</option>
                  <option value="rfp_manager">RFP Manager</option>
                  <option value="other">Other</option>
                </select>

                <select
                  value={orgSize}
                  onChange={(e) => setOrgSize(e.target.value)}
                  className="landing-select"
                >
                  <option value="">Organization size (optional)</option>
                  <option value="1-10">1-10</option>
                  <option value="11-50">11-50</option>
                  <option value="51-200">51-200</option>
                  <option value="201-1000">201-1000</option>
                  <option value="1000+">1000+</option>
                </select>
              </div>

              {submitStatus === 'error' && (
                <div className="landing-form-error">{errorMessage}</div>
              )}

              <button
                type="submit"
                className="landing-btn primary"
                disabled={submitStatus === 'loading'}
              >
                {submitStatus === 'loading' ? 'Joining...' : 'Join Waitlist'}
              </button>

              <p className="landing-form-privacy">
                We'll email you when HeroDocs is ready. Unsubscribe anytime.
              </p>
            </form>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="landing-footer-content">
          <p className="landing-copyright">&copy; 2025 HeroDocs</p>
          <div className="landing-footer-links">
            <a href="mailto:contact@herodocs.ai">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
