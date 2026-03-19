import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import UserProfileBadge from '../components/UserProfileBadge';
import Logo from '../components/Logo';
import './AdminPage.css';

export default function AdminPage({ onNavigateHome, onNavigateToSettings, user }) {
  const { api, logout } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [grantingUserId, setGrantingUserId] = useState(null);
  const [grantAmount, setGrantAmount] = useState('');
  const [grantMemo, setGrantMemo] = useState('');
  const [grantExpires, setGrantExpires] = useState('');
  const [grantError, setGrantError] = useState(null);
  const [granting, setGranting] = useState(false);

  useEffect(() => {
    document.title = 'Admin - Squire Docs';
    fetchUsers();
    return () => { document.title = 'Squire Docs'; };
  }, [api]);

  const fetchUsers = () => {
    api.get('/api/admin/users')
      .then((res) => setUsers(res.data.users))
      .catch((err) => {
        if (err.response?.status === 403) {
          setError('Access denied. You must be an admin to view this page.');
        } else {
          setError(err.response?.data?.error || err.message);
        }
      })
      .finally(() => setLoading(false));
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  };

  const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;

  const handleGrant = async (userId) => {
    const cents = Math.round(parseFloat(grantAmount) * 100);
    if (!cents || cents <= 0) {
      setGrantError('Enter a valid amount');
      return;
    }
    setGranting(true);
    setGrantError(null);
    try {
      await api.post('/api/admin/users/extra-credits', {
        userId,
        amountCents: cents,
        memo: grantMemo || undefined,
        expiresAt: grantExpires || undefined,
      });
      setGrantingUserId(null);
      setGrantAmount('');
      setGrantMemo('');
      setGrantExpires('');
      fetchUsers();
    } catch (err) {
      setGrantError(err.response?.data?.error || 'Failed to grant credits');
    } finally {
      setGranting(false);
    }
  };

  const cancelGrant = () => {
    setGrantingUserId(null);
    setGrantAmount('');
    setGrantMemo('');
    setGrantExpires('');
    setGrantError(null);
  };

  return (
    <>
      <header className="app-header">
        <div className="app-header-content">
          <div className="app-header-left">
            <button className="back-btn" onClick={onNavigateHome} title="Back to Documents">
              <Logo />
            </button>
            <h1>Admin</h1>
          </div>
          <div className="app-header-right">
            <UserProfileBadge
              user={user}
              onLogout={logout}
              onNavigateToSettings={onNavigateToSettings}
            />
          </div>
        </div>
      </header>

      <div className="admin-page">
        {loading && (
          <div className="admin-loading">
            <div className="loading-spinner"></div>
            Loading users...
          </div>
        )}

        {error && <div className="admin-error">{error}</div>}

        {!loading && !error && (
          <div className="admin-table-wrapper">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Created</th>
                  <th>Last Login</th>
                  <th>Docs</th>
                  <th>AI Used</th>
                  <th>Extra Credit</th>
                  <th>AI Remaining</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="admin-cell-name">
                      {u.picture && (
                        <img src={u.picture} alt="" className="admin-avatar" referrerPolicy="no-referrer" />
                      )}
                      {u.name || '—'}
                      {u.isAdmin && <span className="admin-badge">Admin</span>}
                    </td>
                    <td>{u.email}</td>
                    <td>{formatDate(u.createdAt)}</td>
                    <td>{formatDate(u.lastLoginAt)}</td>
                    <td>{u.docCount}</td>
                    <td>{formatCents(u.aiUsedCents)}</td>
                    <td>{u.aiExtraCreditCents > 0 ? formatCents(u.aiExtraCreditCents) : '—'}</td>
                    <td>{formatCents(u.aiRemainingCents)}</td>
                    <td>
                      {grantingUserId === u.id ? (
                        <div className="admin-grant-form">
                          <input
                            type="number"
                            step="0.01"
                            min="0.01"
                            placeholder="$"
                            value={grantAmount}
                            onChange={(e) => setGrantAmount(e.target.value)}
                            disabled={granting}
                            className="admin-grant-amount"
                          />
                          <input
                            type="text"
                            placeholder="Memo"
                            value={grantMemo}
                            onChange={(e) => setGrantMemo(e.target.value)}
                            disabled={granting}
                            className="admin-grant-memo"
                          />
                          <input
                            type="date"
                            value={grantExpires}
                            onChange={(e) => setGrantExpires(e.target.value)}
                            disabled={granting}
                            className="admin-grant-expires"
                            title="Expiration date (optional)"
                          />
                          <button
                            className="admin-grant-confirm"
                            onClick={() => handleGrant(u.id)}
                            disabled={granting}
                          >
                            {granting ? '...' : 'Confirm'}
                          </button>
                          <button className="admin-grant-cancel" onClick={cancelGrant}>
                            Cancel
                          </button>
                          {grantError && <span className="admin-grant-error">{grantError}</span>}
                        </div>
                      ) : (
                        <button
                          className="admin-grant-btn"
                          onClick={() => { setGrantingUserId(u.id); setGrantError(null); }}
                        >
                          Grant
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
