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

  useEffect(() => {
    document.title = 'Admin - Squire Docs';
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

    return () => { document.title = 'Squire Docs'; };
  }, [api]);

  const formatDate = (dateString) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  };

  const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;

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
                  <th>AI Remaining</th>
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
                    <td>{formatCents(u.aiRemainingCents)}</td>
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
