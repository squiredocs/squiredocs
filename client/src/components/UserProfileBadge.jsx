import { useState } from 'react';
import Avatar from './Avatar';
import ThemeControl from './ThemeControl';
import './UserProfileBadge.css';

/**
 * User profile badge component with dropdown menu
 */
export default function UserProfileBadge({ user, onLogout, onNavigateToSettings, onNavigateToSupport, onNavigateToAdmin }) {
  const [showMenu, setShowMenu] = useState(false);

  const handleSettingsClick = () => {
    setShowMenu(false);
    if (onNavigateToSettings) {
      onNavigateToSettings();
    }
  };

  const handleSupportClick = () => {
    setShowMenu(false);
    if (onNavigateToSupport) {
      onNavigateToSupport();
    }
  };

  const handleAdminClick = () => {
    setShowMenu(false);
    if (onNavigateToAdmin) {
      onNavigateToAdmin();
    }
  };

  return (
    <div className="user-profile-badge">
      <button 
        className="user-profile-trigger"
        onClick={() => setShowMenu(!showMenu)}
        aria-expanded={showMenu}
      >
        <Avatar picture={user?.picture} name={user?.name} className="user-avatar-small" />
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
            {user?.isAdmin && onNavigateToAdmin && (
              <button className="user-menu-item" onClick={handleAdminClick}>
                Admin
              </button>
            )}
            {onNavigateToSettings && (
              <button className="user-menu-item" onClick={handleSettingsClick}>
                ⚙️ Settings
              </button>
            )}
            {onNavigateToSupport && (
              <button className="user-menu-item" onClick={handleSupportClick}>
                💬 Get Support
              </button>
            )}
            <a
              className="user-menu-item"
              href="/documentation"
              target="_blank"
              rel="noopener"
              onClick={() => setShowMenu(false)}
            >
              📖 Documentation
            </a>
            <button className="user-menu-item" onClick={onLogout}>
              Sign out
            </button>
            <div className="user-menu-divider" />
            <ThemeControl />
          </div>
        </>
      )}
    </div>
  );
}

