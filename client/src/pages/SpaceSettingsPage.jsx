/**
 * Space settings (feature 053, US4 / FR-042).
 *
 * The whole membership lifecycle in one page: rename, invite, change roles,
 * revoke pending invites, leave, delete.
 *
 * WHAT IS SHOWN TO WHOM follows the operations matrix, not a single "is admin"
 * flag. Any member may invite (capped at their own role) and may leave; only an
 * owner may rename, delete, change a role, remove someone else, or revoke an
 * invite. Controls a member cannot use are HIDDEN rather than disabled: a
 * viewer has no path to them at all, so a greyed-out Delete would only invite
 * the question "why not".
 *
 * The last-owner refusal comes back from the server as a 409 with guidance; it
 * is surfaced verbatim, because the fix ("make someone else an owner first") is
 * something only the message can say.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import Logo from '../components/Logo';
import UserProfileBadge from '../components/UserProfileBadge';
import ViewToggleButton from '../components/ViewToggleButton';
import Avatar from '../components/Avatar';
import { useAuth } from '../contexts/AuthContext';
import useAuthProviders from '../hooks/useAuthProviders';
import { localInviteNote } from '../utils/localModeInvite';
import './SpaceSettingsPage.css';

const ROLES = ['viewer', 'editor', 'owner'];
const RANK = { viewer: 1, editor: 2, owner: 3 };

export default function SpaceSettingsPage({
  spaceId,
  onNavigateHome,
  onNavigateToSettings,
  onNavigateToSupport,
  onNavigateToAdmin,
  onNavigateToChat,
  user,
}) {
  const { api, logout } = useAuth();
  const providers = useAuthProviders();
  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('viewer');
  const [suggestions, setSuggestions] = useState([]);
  const skipSearchRef = useRef(false);

  const myRole = detail?.space?.role || null;
  const isOwner = myRole === 'owner';

  const load = useCallback(async () => {
    try {
      const res = await api.get(`/api/spaces/${spaceId}`);
      setDetail(res.data);
      setName(res.data.space.name);
      setLoadError(null);
    } catch (e) {
      // A non-member gets the same 404 as a space that does not exist — there
      // is deliberately nothing here to distinguish them (RBD-053-10).
      setLoadError(e.response?.data?.error || 'Space not found');
    }
  }, [api, spaceId]);

  useEffect(() => { load(); }, [load]);

  // Reuse the share dialog's user autocomplete so inviting someone feels the
  // same in both places.
  useEffect(() => {
    if (skipSearchRef.current) {
      skipSearchRef.current = false;
      return;
    }
    const q = inviteEmail.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await api.get('/api/users/search', { params: { q } });
        setSuggestions(res.data.users || []);
      } catch {
        setSuggestions([]);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [inviteEmail, api]);

  /** Run a mutation, surface the server's message verbatim, then reload. */
  const run = async (fn, successMessage) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (successMessage) setNotice(successMessage);
      await load();
      return true;
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleRename = () => run(
    () => api.patch(`/api/spaces/${spaceId}`, { name }),
    'Space renamed.'
  );

  const handleInvite = () => {
    const email = inviteEmail.trim();
    if (!email) return;
    let pendingInvite = false;
    return run(async () => {
      const res = await api.post(`/api/spaces/${spaceId}/members`, { email, role: inviteRole });
      pendingInvite = !!res?.data?.invite;
      setInviteEmail('');
      setSuggestions([]);
      return res;
    }, `Invited ${email}.`).then((ok) => {
      // Feature 059: on a local instance a pending invite cannot be accepted yet.
      if (ok && pendingInvite && providers.info?.mode === 'local') setNotice(localInviteNote(email));
      return ok;
    });
  };

  const handleRoleChange = (member, role) => run(
    () => api.put(`/api/spaces/${spaceId}/members/${member.userId}`, { role }),
    null
  );

  const handleRemove = (member) => run(
    () => api.delete(`/api/spaces/${spaceId}/members/${member.userId}`),
    null
  );

  const handleLeave = async () => {
    const ok = await run(() => api.delete(`/api/spaces/${spaceId}/members/${user.id}`), null);
    if (ok) onNavigateHome();
  };

  const handleRevoke = (invite) => run(
    () => api.delete(`/api/spaces/${spaceId}/invites`, { data: { email: invite.email } }),
    null
  );

  const handleDelete = async () => {
    // FR-024: the count is stated BEFORE the confirmation, and the sentence
    // says plainly that no document is deleted — the fear this dialog has to
    // answer is "am I about to lose the team's work".
    const count = detail?.space?.documentCount ?? 0;
    const docs = count === 1 ? '1 document' : `${count} documents`;
    const message = count === 0
      ? `Delete "${detail.space.name}"? It has no documents.`
      : `Delete "${detail.space.name}"? Its ${docs} will move back to their owners' personal areas. `
        + 'No document is deleted, and nothing is removed from anyone who has it shared directly.';
    if (!window.confirm(message)) return;
    const ok = await run(() => api.delete(`/api/spaces/${spaceId}`), null);
    if (ok) onNavigateHome();
  };

  const header = (
    <header className="app-header">
      <div className="app-header-content">
        <div className="app-header-left">
          <button className="back-btn" onClick={onNavigateHome} title="Back to Documents">
            <Logo />
          </button>
          <h1>{detail?.space?.name || 'Space'}</h1>
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
  );

  if (loadError) {
    return (
      <>
        {header}
        <div className="space-settings"><div className="space-settings-content">
          <div className="space-settings-error">{loadError}</div>
        </div></div>
      </>
    );
  }

  if (!detail) {
    return (
      <>
        {header}
        <div className="space-settings"><div className="space-settings-content"><div className="space-settings-loading">Loading...</div></div></div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="space-settings"><div className="space-settings-content">
        {error && <div className="space-settings-error" role="alert">{error}</div>}
        {notice && <div className="space-settings-notice">{notice}</div>}

        <section className="space-settings-section">
          <h2>Name</h2>
          {isOwner ? (
            <div className="space-settings-row">
              <input
                type="text"
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
                aria-label="Space name"
              />
              <button onClick={handleRename} disabled={busy || !name.trim()}>Save</button>
            </div>
          ) : (
            <p className="space-settings-readonly">{detail.space.name}</p>
          )}
          <p className="space-settings-hint">
            {detail.space.documentCount === 1
              ? '1 document lives here.'
              : `${detail.space.documentCount} documents live here.`}
          </p>
        </section>

        <section className="space-settings-section">
          <h2>Invite</h2>
          <div className="space-settings-row">
            <input
              type="email"
              value={inviteEmail}
              placeholder="Enter email address"
              onChange={(e) => setInviteEmail(e.target.value)}
              aria-label="Invite by email"
              list="space-invite-suggestions"
            />
            <datalist id="space-invite-suggestions">
              {suggestions.map((s) => <option key={s.id} value={s.email}>{s.name}</option>)}
            </datalist>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              aria-label="Invite role"
            >
              {ROLES.filter((r) => RANK[r] <= RANK[myRole]).map((r) => (
                <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>
              ))}
            </select>
            <button onClick={handleInvite} disabled={busy || !inviteEmail.trim()}>Invite</button>
          </div>
          <p className="space-settings-hint">
            You can invite at most at your own level. People without an account get an invite that
            becomes real access the first time they sign in.
          </p>
        </section>

        <section className="space-settings-section">
          <h2>Members</h2>
          <ul className="space-member-list">
            {detail.members.map((member) => {
              const isMe = member.userId === user?.id;
              return (
                <li key={member.userId} className="space-member">
                  <Avatar picture={member.picture} name={member.name} className="space-member-avatar" />
                  <div className="space-member-info">
                    <span className="space-member-name">{member.name}{isMe ? ' (you)' : ''}</span>
                    <span className="space-member-email">{member.email}</span>
                  </div>
                  {isOwner ? (
                    <select
                      value={member.role}
                      onChange={(e) => handleRoleChange(member, e.target.value)}
                      disabled={busy}
                      aria-label={`Role for ${member.email}`}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="space-member-role">{member.role}</span>
                  )}
                  {isOwner && !isMe && (
                    <button
                      className="space-member-remove"
                      onClick={() => handleRemove(member)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {detail.invites.length > 0 && (
          <section className="space-settings-section">
            <h2>Pending invites</h2>
            <ul className="space-member-list">
              {detail.invites.map((invite) => (
                <li key={invite.email} className="space-member">
                  <div className="space-member-info">
                    <span className="space-member-name">{invite.email}</span>
                    <span className="space-member-email">Invited as {invite.role}</span>
                  </div>
                  {isOwner && (
                    <button
                      className="space-member-remove"
                      onClick={() => handleRevoke(invite)}
                      disabled={busy}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="space-settings-section space-settings-danger">
          <h2>Leaving and deleting</h2>
          <div className="space-settings-row">
            <button onClick={handleLeave} disabled={busy}>Leave this space</button>
            {isOwner && (
              <button className="danger" onClick={handleDelete} disabled={busy}>
                Delete space
              </button>
            )}
          </div>
          <p className="space-settings-hint">
            Leaving removes your membership only — documents shared with you directly stay shared.
            Deleting a space moves its documents back to their owners' personal areas; no document
            is deleted.
          </p>
        </section>
      </div></div>
    </>
  );
}
