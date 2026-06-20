/**
 * Support Page
 *
 * A dedicated page (reached from the user menu) where a user can submit a
 * support request and review their previous requests.
 */
import { useState, useEffect, useCallback } from 'react';
import Logo from '../components/Logo';
import UserProfileBadge from '../components/UserProfileBadge';
import ViewToggleButton from '../components/ViewToggleButton';
import { useAuth } from '../contexts/AuthContext';

const MAX_MESSAGE_LENGTH = 5000;

export default function SupportPage({ onNavigateHome, onNavigateToSettings, onNavigateToSupport, onNavigateToAdmin, onNavigateToChat, user }) {
  const { api, logout } = useAuth();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const [requests, setRequests] = useState(null);

  const loadRequests = useCallback(() => {
    api.get('/api/support')
      .then((res) => setRequests(res.data.requests))
      .catch(() => setRequests([]));
  }, [api]);

  useEffect(() => { loadRequests(); }, [loadRequests]);

  const handleSubmit = async () => {
    const trimmed = message.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);
    try {
      await api.post('/api/support', { message: trimmed });
      setMessage('');
      setSent(true);
      loadRequests();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to send. Please try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <header className="app-header">
        <div className="app-header-content">
          <div className="app-header-left">
            <button className="back-btn" onClick={onNavigateHome} title="Back to Documents">
              <Logo />
            </button>
            <h1>Get Support</h1>
          </div>
          <div className="app-header-right">
            <ViewToggleButton onClick={onNavigateToChat} />
            <UserProfileBadge
              user={user}
              onLogout={logout}
              onNavigateToSettings={onNavigateToSettings}
              onNavigateToSupport={onNavigateToSupport}
              onNavigateToAdmin={onNavigateToAdmin}
            />
          </div>
        </div>
      </header>

      <div className="settings-page">
        <div className="settings-content">
          <section className="settings-section">
            <h2>Describe your issue</h2>
            <p className="settings-description">
              Run into a problem or have a question? Tell us what's going on and we'll get back to you by email.
            </p>
            <div className="support-form">
              <textarea
                className="support-textarea"
                rows={6}
                maxLength={MAX_MESSAGE_LENGTH}
                placeholder="Describe your issue..."
                value={message}
                onChange={(e) => { setMessage(e.target.value); setSent(false); setError(null); }}
                disabled={sending}
              />
              <div className="support-form-footer">
                {error && <div className="support-error">{error}</div>}
                {sent && !error && (
                  <div className="support-success">Thanks — your request has been sent.</div>
                )}
                <button
                  className="support-submit"
                  onClick={handleSubmit}
                  disabled={sending || !message.trim()}
                >
                  {sending ? 'Sending...' : 'Send'}
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h2>Previous requests</h2>
            {requests === null ? (
              <p className="settings-description">Loading…</p>
            ) : requests.length === 0 ? (
              <p className="settings-description">You haven't submitted any support requests yet.</p>
            ) : (
              <ul className="support-history">
                {requests.map((r) => (
                  <li key={r.id} className="support-history-item">
                    <div className="support-history-date">
                      {new Date(r.createdAt).toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </div>
                    <div className="support-history-message">{r.message}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
