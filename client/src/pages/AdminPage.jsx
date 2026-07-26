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
  const [modelPinError, setModelPinError] = useState(null);

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

  // Both captured origins on the IP cell's hover, since the list shows only the
  // latest address. The full values also live in the expanded row.
  const originTitle = (u) => [
    `Signup ${u.signupIp || '—'} · ${u.signupUserAgent || 'no user-agent recorded'}`,
    `Last login ${u.lastLoginIp || '—'} · ${u.lastLoginUserAgent || 'no user-agent recorded'}`,
  ].join('\n');

  // Human label for a model key from the shared-model settings payload. Stays
  // price-free — it's used mid-sentence ("Deployment default (…)").
  const modelLabel = (settings, key) =>
    settings?.models.find((m) => m.key === key)?.label || key;

  // Registry pricing is cents per 1M tokens, so 500 → "$5" and 30 → "$0.30".
  // Whole dollars drop the decimals so the list stays scannable.
  const pricePerMTok = (cents) =>
    (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

  // Picker option text: "Claude Opus 5 — $5/$25 per 1M" (input/output). A model
  // with no pricing in the registry renders label-only rather than "$NaN", and a
  // genuinely free one reads "free" instead of "$0/$0" noise.
  const modelOptionLabel = (m) => {
    const p = m.pricing;
    if (!p || !Number.isFinite(p.input) || !Number.isFinite(p.output)) return m.label;
    if (p.input === 0 && p.output === 0) return `${m.label} — free`;
    return `${m.label} — ${pricePerMTok(p.input)}/${pricePerMTok(p.output)} per 1M`;
  };

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
    setModelPinError(null);
    try {
      await api.patch(`/api/admin/users/${u.id}/chat-model`, { modelKey: value === '' ? null : value });
      fetchUsers(); // re-read the stored state; expandedUserId is separate state, so the row stays open
    } catch (err) {
      // This endpoint 400s by design — a model whose provider key was withdrawn
      // since page load is rejected. Swallowing that would silently snap the
      // select back with no explanation, which reads as "the click did nothing".
      setModelPinError(err.response?.data?.error || 'Could not set the model for this user.');
      fetchUsers();
    } finally { setSavingModelUserId(null); }
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
  const colCount = 6;

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
                        <option key={m.key} value={m.key}>{modelOptionLabel(m)}</option>
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
                  {/* Related fields share a cell (identity, dates, credit) so the
                      table fits beside the assistant panel instead of scrolling.
                      Anything only read one user at a time lives in the expanded
                      row — see the Sign-in origin block below. */}
                  <th>User</th>
                  <th>Activity</th>
                  {/* Feature 034 — the at-a-glance multi-account spray signal is a
                      REPEATED address, so the list shows the latest one and the
                      title/expanded row carry both plus their user-agents. */}
                  <th>IP</th>
                  <th className="admin-col-num">Docs</th>
                  <th>AI credit</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isExpanded = expandedUserId === u.id;
                  return [
                    // Main user row
                    <tr key={u.id} className={isExpanded ? 'admin-row-expanded' : ''}>
                      <td className="admin-cell-user">
                        <Avatar picture={u.picture} name={u.name} className="admin-avatar" />
                        <div className="admin-user-lines">
                          <div className="admin-user-name">
                            {u.name || '—'}
                            {u.isAdmin && <span className="admin-badge">Admin</span>}
                            {/* A pinned model is rare and consequential, so it earns a
                                badge in the list rather than hiding behind an expand.
                                Absent for everyone else, so it costs no column width. */}
                            {u.chatModelOverride && (
                              <span
                                className="admin-badge admin-badge-model"
                                title={`Assistant model pinned to ${modelLabel(sharedModel, u.chatModelOverride)} for this user`}
                              >
                                {modelLabel(sharedModel, u.chatModelOverride)}
                              </span>
                            )}
                          </div>
                          <div className="admin-user-email" title={u.email}>{u.email}</div>
                        </div>
                      </td>
                      {/* data-label feeds the mobile card layout: below 768px the
                          header row is hidden and each cell prints its own label
                          (see AdminPage.css). Keep them in sync with the <th>s. */}
                      <td data-label="Activity">
                        <div>{formatDate(u.createdAt)}</div>
                        <div className="admin-cell-sub">
                          {u.lastLoginAt ? `seen ${formatDate(u.lastLoginAt)}` : 'never signed in'}
                        </div>
                      </td>
                      {/* Values are React text children — auto-escaped. The
                          user-agent is attacker-controlled input and must never
                          be rendered with dangerouslySetInnerHTML. */}
                      <td className="admin-cell-ip" data-label="IP" title={originTitle(u)}>
                        {u.lastLoginIp || u.signupIp || '—'}
                      </td>
                      <td className="admin-col-num" data-label="Docs">{u.docCount}</td>
                      <td className="admin-cell-credit" data-label="AI credit">
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
                          <>
                            <div>
                              {formatCents(u.aiUsedCents)}
                              {' / '}
                              <span
                                className="admin-editable"
                                onClick={() => startEditCredit(u)}
                                title="Click to edit the monthly limit"
                              >
                                {formatCents(u.aiCreditCents)}
                              </span>
                            </div>
                            <div className={`admin-cell-sub${u.aiRemainingCents <= 0 ? ' admin-cell-sub-spent' : ''}`}>
                              {formatCents(u.aiRemainingCents)} left
                              {u.aiExtraCreditCents > 0 && (
                                <span className="admin-extra-tag" title="Includes extra credits">
                                  +{formatCents(u.aiExtraCreditCents)}
                                </span>
                              )}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="admin-actions">
                        <button
                          className="admin-btn-icon"
                          onClick={() => handleSendWelcome(u)}
                          disabled={sendingWelcomeUserId === u.id}
                          aria-label="Send welcome email"
                          title={u.welcomeEmailSentAt
                            ? `Welcome email sent ${formatDate(u.welcomeEmailSentAt)} — click to resend`
                            : 'Send the beta welcome email to this user (you are BCC’d)'}
                        >
                          {sendingWelcomeUserId === u.id
                            ? '…'
                            : (u.welcomeEmailSentAt ? '✓' : '✉')}
                        </button>
                        <button
                          className="admin-btn-icon"
                          onClick={() => toggleExpand(u.id)}
                          aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                          title={isExpanded
                            ? 'Collapse'
                            : 'Details — sign-in origin, sharing, extra credits'}
                        >
                          {isExpanded ? '▾' : '▸'}
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
                              {modelPinError && savingModelUserId !== u.id && (
                                <div className="admin-detail-error">{modelPinError}</div>
                              )}
                              {/* A text-only model breaks this user's image attachments —
                                  the server rejects the turn with model_no_image_support and,
                                  because the pin is never disclosed to them (FR-011), nothing
                                  can explain why. Say so here, where the choice is made. */}
                              {sharedModel && u.chatModelOverride
                                && sharedModel.models.some(
                                  (m) => m.key === u.chatModelOverride && m.supportsImages === false,
                                ) && (
                                <div className="admin-detail-note">
                                  Text-only model — this user cannot attach images to chats while pinned.
                                </div>
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
