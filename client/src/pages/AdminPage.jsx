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

  // Expanded user row — shows extra credit + sharing detail
  const [expandedUserId, setExpandedUserId] = useState(null);
  const [extraCredits, setExtraCredits] = useState([]);
  const [extraCreditsLoading, setExtraCreditsLoading] = useState(false);
  const [sharing, setSharing] = useState(null);
  const [sharingLoading, setSharingLoading] = useState(false);

  // Trusted (email sending) toggle
  const [togglingEmailUserId, setTogglingEmailUserId] = useState(null);

  // Welcome-email send (per-row)
  const [sendingWelcomeUserId, setSendingWelcomeUserId] = useState(null);

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

  // Shared assistant default model
  const [sharedModel, setSharedModel] = useState(null);
  const [savingSharedModel, setSavingSharedModel] = useState(false);

  // Per-user assistant model pin (feature 035) — admin-only, invisible to the user
  const [savingModelUserId, setSavingModelUserId] = useState(null);

  // Prod first-run self-test reset (029/030): one hardcoded throwaway account,
  // admin-gated server-side. The button spares an admin from copying the session
  // cookie out of DevTools to re-run the onboarding walk (Sam, 2026-07-22).
  const [resettingSelfTest, setResettingSelfTest] = useState(false);
  const [selfTestResult, setSelfTestResult] = useState(null);

  useEffect(() => {
    document.title = 'Admin - Squire Docs';
    fetchUsers();
    fetchSharedModel();
    return () => { document.title = 'Squire Docs'; };
  }, [api]);

  const fetchSharedModel = () => {
    api.get('/api/admin/settings/shared-model')
      .then((res) => setSharedModel(res.data))
      .catch(() => setSharedModel(null));
  };

  // Empty string = "Deployment default" → clears the override (sends null).
  const handleSharedModelChange = async (e) => {
    const value = e.target.value;
    setSavingSharedModel(true);
    try {
      const res = await api.put('/api/admin/settings/shared-model', {
        modelKey: value === '' ? null : value,
      });
      setSharedModel(res.data);
    } catch { /* ignore */ }
    finally { setSavingSharedModel(false); }
  };

  const handleResetSelfTest = async () => {
    setResettingSelfTest(true);
    setSelfTestResult(null);
    try {
      const res = await api.post('/auth/prod-reset-selftest-account');
      const { account, deleted, docCount } = res.data;
      setSelfTestResult({
        ok: true,
        message: deleted
          ? `Reset ${account} — removed the account and ${docCount} doc${docCount === 1 ? '' : 's'}. Next sign-in is a fresh first-run.`
          : `${account} was already empty — nothing to reset. Next sign-in is a fresh first-run.`,
      });
    } catch (err) {
      setSelfTestResult({
        ok: false,
        message: err.response?.data?.error || err.message,
      });
    } finally {
      setResettingSelfTest(false);
    }
  };

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

  // Human label for a model key from the shared-model settings payload.
  const modelLabel = (settings, key) =>
    settings?.models.find((m) => m.key === key)?.label || key;

  // -- Expand/collapse extra credits --

  const toggleExpand = async (userId) => {
    if (expandedUserId === userId) {
      setExpandedUserId(null);
      setExtraCredits([]);
      setSharing(null);
      return;
    }
    setExpandedUserId(userId);
    setExtraCreditsLoading(true);
    setSharingLoading(true);
    api.get(`/api/admin/users/${userId}/extra-credits`)
      .then((res) => setExtraCredits(res.data.credits))
      .catch(() => setExtraCredits([]))
      .finally(() => setExtraCreditsLoading(false));
    api.get(`/api/admin/users/${userId}/sharing`)
      .then((res) => setSharing(res.data))
      .catch(() => setSharing({ invites: [], shares: [] }))
      .finally(() => setSharingLoading(false));
  };

  const toggleEmailEnabled = async (u) => {
    setTogglingEmailUserId(u.id);
    try {
      await api.patch(`/api/admin/users/${u.id}/email-enabled`, { emailEnabled: !u.emailEnabled });
      fetchUsers();
    } catch { /* ignore */ }
    finally { setTogglingEmailUserId(null); }
  };

  // Empty string = "Default" → clears the pin (sends null), so the user rejoins
  // the shared default dynamically. Same convention as handleSharedModelChange.
  const handleChatModelChange = async (u, value) => {
    setSavingModelUserId(u.id);
    try {
      await api.patch(`/api/admin/users/${u.id}/chat-model`, { modelKey: value === '' ? null : value });
      fetchUsers(); // re-read the stored state; expandedUserId is separate state, so the row stays open
    } catch { /* ignore — same posture as the neighbouring per-user handlers */ }
    finally { setSavingModelUserId(null); }
  };

  const handleSendWelcome = async (u) => {
    const confirmMsg = u.welcomeEmailSentAt
      ? `The welcome email was already sent to ${u.email} on ${formatDate(u.welcomeEmailSentAt)}. Send it again?`
      : `Send the welcome email to ${u.email}? (You'll be BCC'd.)`;
    if (!window.confirm(confirmMsg)) return;
    setSendingWelcomeUserId(u.id);
    try {
      await api.post(`/api/admin/users/${u.id}/welcome-email`);
      fetchUsers();
    } catch (err) {
      window.alert(err.response?.data?.error || 'Failed to send welcome email');
    } finally {
      setSendingWelcomeUserId(null);
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
  // Column count drives the detail row's colSpan. 9 base columns + the two
  // feature-034 origin columns (Signup IP / Login IP).
  const colCount = 11;

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
        {sharedModel && (
          <div className="admin-settings-card">
            <div className="admin-settings-heading">
              <h3>Shared assistant</h3>
              <p>Default model used by the in-app AI assistant for users on the shared key (non-BYOK).</p>
            </div>
            <div className="admin-settings-control">
              <label htmlFor="shared-model-select">Default model</label>
              <select
                id="shared-model-select"
                value={sharedModel.modelKey ?? ''}
                onChange={handleSharedModelChange}
                disabled={savingSharedModel}
              >
                <option value="">
                  Deployment default ({modelLabel(sharedModel, sharedModel.deploymentDefaultKey ?? sharedModel.effectiveModelKey)})
                </option>
                {/* A stored default can outlive its provider's server key (rollback
                    path): keep the controlled value renderable and say what's
                    actually in effect instead of showing a blank select. */}
                {sharedModel.modelKey !== null
                  && !sharedModel.models.some((m) => m.key === sharedModel.modelKey) && (
                  <option value={sharedModel.modelKey} disabled>
                    {sharedModel.modelKey} (unavailable — using {modelLabel(sharedModel, sharedModel.effectiveModelKey)})
                  </option>
                )}
                {(sharedModel.providers ?? []).map((p) => (
                  <optgroup key={p.id} label={p.label}>
                    {sharedModel.models
                      .filter((m) => m.provider === p.id)
                      .map((m) => (
                        <option key={m.key} value={m.key}>{m.label}</option>
                      ))}
                  </optgroup>
                ))}
              </select>
              {savingSharedModel && <span className="admin-settings-status">Saving…</span>}
            </div>
          </div>
        )}

        <div className="admin-settings-card">
          <div className="admin-settings-heading">
            <h3>Plugin first-run self-test</h3>
            <p>
              Reset the onboarding self-test account (a single hardcoded throwaway)
              to a fresh first-run, so you can walk <code>/squire:onboard</code> as a
              brand-new user again. Removes that account and its docs only.
            </p>
          </div>
          <div className="admin-settings-control">
            <button
              type="button"
              className="admin-btn-sm admin-btn-primary"
              onClick={handleResetSelfTest}
              disabled={resettingSelfTest}
            >
              {resettingSelfTest ? 'Resetting…' : 'Reset self-test account'}
            </button>
            {selfTestResult && (
              <span className={selfTestResult.ok ? 'admin-settings-status' : 'admin-error-inline'}>
                {selfTestResult.message}
              </span>
            )}
          </div>
        </div>

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
                  {/* Feature 034 — signup/last-login origin, the at-a-glance
                      multi-account spray signal. Hover reveals the user-agent. */}
                  <th>Signup IP</th>
                  <th>Login IP</th>
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
                      {/* Values are React text children — auto-escaped. The
                          user-agent is attacker-controlled input and must never
                          be rendered with dangerouslySetInnerHTML. */}
                      <td
                        className="admin-cell-ip"
                        title={u.signupUserAgent || 'No user-agent recorded'}
                      >
                        {u.signupIp || '—'}
                      </td>
                      <td
                        className="admin-cell-ip"
                        title={u.lastLoginUserAgent || 'No user-agent recorded'}
                      >
                        {u.lastLoginIp || '—'}
                      </td>
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
                          onClick={() => handleSendWelcome(u)}
                          disabled={sendingWelcomeUserId === u.id}
                          title={u.welcomeEmailSentAt
                            ? `Welcome email sent ${formatDate(u.welcomeEmailSentAt)} — click to resend`
                            : 'Send the beta welcome email to this user (you are BCC’d)'}
                        >
                          {sendingWelcomeUserId === u.id
                            ? 'Sending…'
                            : `${u.welcomeEmailSentAt ? '✓' : '✉'} Welcome email`}
                        </button>
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
                            <div className="admin-detail-section">
                              <label className="admin-trusted-toggle">
                                <input
                                  type="checkbox"
                                  checked={!!u.emailEnabled}
                                  disabled={togglingEmailUserId === u.id}
                                  onChange={() => toggleEmailEnabled(u)}
                                />
                                Trusted — can send share invitation emails
                              </label>
                            </div>

                            {/* Feature 035 — per-user assistant model pin. Options come
                                from the SAME shared-model payload the default picker
                                above uses, so the two lists cannot drift. Admin-only:
                                nothing about this is shown to the user it applies to. */}
                            <div className="admin-detail-section">
                              <h4>Assistant model</h4>
                              {!sharedModel ? (
                                <div className="admin-detail-empty">Model list unavailable.</div>
                              ) : (
                                <select
                                  value={u.chatModelOverride ?? ''}
                                  disabled={savingModelUserId === u.id}
                                  onChange={(e) => handleChatModelChange(u, e.target.value)}
                                >
                                  <option value="">
                                    Default ({modelLabel(sharedModel, sharedModel.effectiveModelKey)})
                                  </option>
                                  {/* A pin can outlive its provider's server key: keep the
                                      controlled value renderable and say what the user is
                                      actually getting, rather than misreporting "Default". */}
                                  {u.chatModelOverride
                                    && !sharedModel.models.some((m) => m.key === u.chatModelOverride) && (
                                    <option value={u.chatModelOverride} disabled>
                                      {u.chatModelOverride} (unavailable — using {modelLabel(sharedModel, sharedModel.effectiveModelKey)})
                                    </option>
                                  )}
                                  {(sharedModel.providers ?? []).map((p) => (
                                    <optgroup key={p.id} label={p.label}>
                                      {sharedModel.models
                                        .filter((m) => m.provider === p.id)
                                        .map((m) => (
                                          <option key={m.key} value={m.key}>{m.label}</option>
                                        ))}
                                    </optgroup>
                                  ))}
                                </select>
                              )}
                            </div>

                            {/* Feature 034 — full, untruncated capture values.
                                Rendered as text children only (React escapes). */}
                            <div className="admin-detail-section">
                              <h4>Sign-in origin</h4>
                              <dl className="admin-origin-list">
                                <dt>Signup IP</dt>
                                <dd>{u.signupIp || '—'}</dd>
                                <dt>Signup user-agent</dt>
                                <dd className="admin-origin-ua">{u.signupUserAgent || '—'}</dd>
                                <dt>Last login IP</dt>
                                <dd>{u.lastLoginIp || '—'}</dd>
                                <dt>Last login user-agent</dt>
                                <dd className="admin-origin-ua">{u.lastLoginUserAgent || '—'}</dd>
                              </dl>
                            </div>

                            <div className="admin-detail-section">
                              <h4>Sharing activity</h4>
                              {sharingLoading ? (
                                <div className="admin-detail-loading">Loading...</div>
                              ) : (
                                <>
                                  <h5>Invites sent</h5>
                                  {!sharing || sharing.invites.length === 0 ? (
                                    <div className="admin-detail-empty">No invites sent.</div>
                                  ) : (
                                    <table className="admin-credits-table">
                                      <thead>
                                        <tr><th>Email</th><th>Role</th><th>Document</th><th>Sent</th></tr>
                                      </thead>
                                      <tbody>
                                        {sharing.invites.map((inv) => (
                                          <tr key={inv.id}>
                                            <td>{inv.email}</td>
                                            <td>{inv.role}</td>
                                            <td>{inv.docTitle || 'Untitled document'}</td>
                                            <td>{formatDate(inv.createdAt)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}

                                  <h5>Shared on owned docs</h5>
                                  {!sharing || sharing.shares.length === 0 ? (
                                    <div className="admin-detail-empty">No collaborators on owned docs.</div>
                                  ) : (
                                    <table className="admin-credits-table">
                                      <thead>
                                        <tr><th>Document</th><th>Collaborator</th><th>Email</th><th>Role</th><th>Since</th></tr>
                                      </thead>
                                      <tbody>
                                        {sharing.shares.map((s, i) => (
                                          <tr key={`${s.docId}-${s.email}-${i}`}>
                                            <td>{s.docTitle || 'Untitled document'}</td>
                                            <td>{s.name || '—'}</td>
                                            <td>{s.email}</td>
                                            <td>{s.role}</td>
                                            <td>{formatDate(s.createdAt)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </>
                              )}
                            </div>

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
