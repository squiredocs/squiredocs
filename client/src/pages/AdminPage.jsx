import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import UserProfileBadge from '../components/UserProfileBadge';
import Avatar from '../components/Avatar';
import Logo from '../components/Logo';
import ViewToggleButton from '../components/ViewToggleButton';
import './AdminPage.css';

export default function AdminPage({ onNavigateHome, onNavigateToSettings, onNavigateToSupport, onNavigateToChat, user }) {
  const { api, logout } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Expanded user row — shows extra credit detail
  const [expandedUserId, setExpandedUserId] = useState(null);
  const [extraCredits, setExtraCredits] = useState([]);
  const [extraCreditsLoading, setExtraCreditsLoading] = useState(false);

  // Grant form state
  const [grantingUserId, setGrantingUserId] = useState(null);
  const [grantAmount, setGrantAmount] = useState('');
  const [grantMemo, setGrantMemo] = useState('');
  const [grantExpires, setGrantExpires] = useState('');
  const [grantError, setGrantError] = useState(null);
  const [granting, setGranting] = useState(false);

  // Monthly allowance editing
  const [editingCreditUserId, setEditingCreditUserId] = useState(null);
  const [editCreditValue, setEditCreditValue] = useState('');
  const [savingCredit, setSavingCredit] = useState(false);

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

  // -- Expand/collapse extra credits --

  const toggleExpand = async (userId) => {
    if (expandedUserId === userId) {
      setExpandedUserId(null);
      setExtraCredits([]);
      return;
    }
    setExpandedUserId(userId);
    setExtraCreditsLoading(true);
    try {
      const res = await api.get(`/api/admin/users/${userId}/extra-credits`);
      setExtraCredits(res.data.credits);
    } catch {
      setExtraCredits([]);
    } finally {
      setExtraCreditsLoading(false);
    }
  };

  const refreshExpanded = async (userId) => {
    try {
      const res = await api.get(`/api/admin/users/${userId}/extra-credits`);
      setExtraCredits(res.data.credits);
    } catch { /* ignore */ }
  };

  // -- Monthly allowance editing --

  const startEditCredit = (u) => {
    setEditingCreditUserId(u.id);
    setEditCreditValue((u.aiCreditCents / 100).toFixed(2));
  };

  const cancelEditCredit = () => {
    setEditingCreditUserId(null);
    setEditCreditValue('');
  };

  const saveCredit = async (userId) => {
    const cents = Math.round(parseFloat(editCreditValue) * 100);
    if (isNaN(cents) || cents < 0) return;
    setSavingCredit(true);
    try {
      await api.patch(`/api/admin/users/${userId}/credit`, { aiCreditCents: cents });
      fetchUsers();
      setEditingCreditUserId(null);
    } catch { /* ignore */ }
    finally { setSavingCredit(false); }
  };

  // -- Grant extra credit --

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
      if (expandedUserId === userId) refreshExpanded(userId);
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

  // -- Delete extra credit --

  const handleDeleteCredit = async (creditId, userId) => {
    if (!window.confirm('Delete this extra credit record?')) return;
    try {
      await api.delete(`/api/admin/users/extra-credits/${creditId}`);
      fetchUsers();
      refreshExpanded(userId);
    } catch { /* ignore */ }
  };

  // -- Column count for detail rows --
  const colCount = 9;

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
            <ViewToggleButton onClick={onNavigateToChat} />
            <UserProfileBadge
              user={user}
              onLogout={logout}
              onNavigateToSettings={onNavigateToSettings}
              onNavigateToSupport={onNavigateToSupport}
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
                  <th>Monthly Limit</th>
                  <th>AI Used</th>
                  <th>AI Remaining</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isExpanded = expandedUserId === u.id;
                  return [
                    // Main user row
                    <tr key={u.id} className={isExpanded ? 'admin-row-expanded' : ''}>
                      <td className="admin-cell-name">
                        <Avatar picture={u.picture} name={u.name} className="admin-avatar" />
                        {u.name || '—'}
                        {u.isAdmin && <span className="admin-badge">Admin</span>}
                      </td>
                      <td>{u.email}</td>
                      <td>{formatDate(u.createdAt)}</td>
                      <td>{formatDate(u.lastLoginAt)}</td>
                      <td>{u.docCount}</td>
                      <td>
                        {editingCreditUserId === u.id ? (
                          <span className="admin-inline-edit">
                            $<input
                              type="number"
                              step="0.01"
                              min="0"
                              value={editCreditValue}
                              onChange={(e) => setEditCreditValue(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') saveCredit(u.id); if (e.key === 'Escape') cancelEditCredit(); }}
                              disabled={savingCredit}
                              className="admin-credit-input"
                              autoFocus
                            />
                            <button className="admin-btn-sm admin-btn-primary" onClick={() => saveCredit(u.id)} disabled={savingCredit}>Save</button>
                            <button className="admin-btn-sm" onClick={cancelEditCredit}>Cancel</button>
                          </span>
                        ) : (
                          <span className="admin-editable" onClick={() => startEditCredit(u)} title="Click to edit">
                            {formatCents(u.aiCreditCents)}
                          </span>
                        )}
                      </td>
                      <td>{formatCents(u.aiUsedCents)}</td>
                      <td>
                        {formatCents(u.aiRemainingCents)}
                        {u.aiExtraCreditCents > 0 && (
                          <span className="admin-extra-tag" title="Includes extra credits">
                            +{formatCents(u.aiExtraCreditCents)}
                          </span>
                        )}
                      </td>
                      <td className="admin-actions">
                        <button
                          className="admin-btn-sm"
                          onClick={() => toggleExpand(u.id)}
                          title={isExpanded ? 'Collapse' : 'Expand extra credits'}
                        >
                          {isExpanded ? '▾' : '▸'} Credits
                        </button>
                      </td>
                    </tr>,

                    // Expanded detail row
                    isExpanded && (
                      <tr key={`${u.id}-detail`} className="admin-detail-row">
                        <td colSpan={colCount}>
                          <div className="admin-detail">
                            <div className="admin-detail-header">
                              <h4>Extra Credits for {u.name || u.email}</h4>
                              {grantingUserId === u.id ? (
                                <div className="admin-grant-form">
                                  <input type="number" step="0.01" min="0.01" placeholder="$" value={grantAmount}
                                    onChange={(e) => setGrantAmount(e.target.value)} disabled={granting} className="admin-grant-amount" />
                                  <input type="text" placeholder="Memo" value={grantMemo}
                                    onChange={(e) => setGrantMemo(e.target.value)} disabled={granting} className="admin-grant-memo" />
                                  <input type="date" value={grantExpires}
                                    onChange={(e) => setGrantExpires(e.target.value)} disabled={granting} className="admin-grant-expires" title="Expiration (optional)" />
                                  <button className="admin-btn-sm admin-btn-primary" onClick={() => handleGrant(u.id)} disabled={granting}>
                                    {granting ? '...' : 'Add'}
                                  </button>
                                  <button className="admin-btn-sm" onClick={cancelGrant}>Cancel</button>
                                  {grantError && <span className="admin-grant-error">{grantError}</span>}
                                </div>
                              ) : (
                                <button className="admin-btn-sm admin-btn-primary" onClick={() => { setGrantingUserId(u.id); setGrantError(null); }}>
                                  + Add Credit
                                </button>
                              )}
                            </div>

                            {extraCreditsLoading ? (
                              <div className="admin-detail-loading">Loading...</div>
                            ) : extraCredits.length === 0 ? (
                              <div className="admin-detail-empty">No extra credit records.</div>
                            ) : (
                              <table className="admin-credits-table">
                                <thead>
                                  <tr>
                                    <th>Amount</th>
                                    <th>Used</th>
                                    <th>Remaining</th>
                                    <th>Memo</th>
                                    <th>Granted By</th>
                                    <th>Created</th>
                                    <th>Expires</th>
                                    <th>Status</th>
                                    <th></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {extraCredits.map((ec) => (
                                    <tr key={ec.id} className={ec.isExpired || ec.isDepleted ? 'admin-credit-inactive' : ''}>
                                      <td>{formatCents(ec.amountCents)}</td>
                                      <td>{formatCents(ec.usedCents)}</td>
                                      <td>{formatCents(ec.remainingCents)}</td>
                                      <td>{ec.memo || '—'}</td>
                                      <td>{ec.grantedByName || '—'}</td>
                                      <td>{formatDate(ec.createdAt)}</td>
                                      <td>{ec.expiresAt ? formatDate(ec.expiresAt) : '—'}</td>
                                      <td>
                                        {ec.isDepleted ? (
                                          <span className="admin-status-badge admin-status-depleted">Depleted</span>
                                        ) : ec.isExpired ? (
                                          <span className="admin-status-badge admin-status-expired">Expired</span>
                                        ) : (
                                          <span className="admin-status-badge admin-status-active">Active</span>
                                        )}
                                      </td>
                                      <td>
                                        <button
                                          className="admin-btn-sm admin-btn-danger"
                                          onClick={() => handleDeleteCredit(ec.id, u.id)}
                                          title="Delete this credit record"
                                        >
                                          Delete
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
