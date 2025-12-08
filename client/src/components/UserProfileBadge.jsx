import { useState } from 'react';
import './UserProfileBadge.css';

/**
 * User profile badge component with dropdown menu
 */
export default function UserProfileBadge({ user, onLogout }) {
  const [showMenu, setShowMenu] = useState(false);

  return (
    <div className="user-profile-badge">
      <button 
        className="user-profile-trigger"
        onClick={() => setShowMenu(!showMenu)}
        aria-expanded={showMenu}
      >
        {user?.picture ? (
          <img 
            src={user.picture} 
            alt={user.name} 
            className="user-avatar-small"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="user-avatar-placeholder-small">
            {user?.name?.charAt(0).toUpperCase() || '?'}
          </div>
        )}
      </button>
      
      {showMenu && (
        <>
          <div className="user-menu-backdrop" onClick={() => setShowMenu(false)} />
          <div className="user-menu">
            <div className="user-menu-header">
              <div className="user-menu-name">{user?.name || 'User'}</div>
              <div className="user-menu-email">{user?.email || ''}</div>
            </div>
            <div className="user-menu-divider" />
            <button className="user-menu-item" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

