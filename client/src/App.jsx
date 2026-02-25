import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AiChatProvider, useAiChat } from './contexts/AiChatContext';
import { useAiPanel } from './hooks/useAiPanel';
import { useMobile } from './hooks/useMobile';
import DocList from './components/DocList';
import EditorView from './components/EditorView';
import AiPanel from './components/AiPanel';
import LoginPage from './components/LoginPage';
import LandingPage from './components/LandingPage';
import AuthorizePage from './pages/AuthorizePage';
import SettingsPage from './pages/SettingsPage';
import './App.css';

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parse the current URL to determine the view
function parseRoute() {
  const path = window.location.pathname;

  // Check for /authorize path (OAuth agent authorization)
  if (path === '/authorize') {
    return { view: 'authorize', docGuid: null };
  }

  // Check for /login path
  if (path === '/login') {
    return { view: 'login', docGuid: null };
  }

  // Check for /settings path
  if (path === '/settings') {
    return { view: 'settings', docGuid: null };
  }

  // Check for /docs path (document list)
  if (path === '/docs') {
    return { view: 'list', docGuid: null };
  }

  // Check for /d/{uuid}/versions or /doc/{uuid}/versions pattern
  const versionsMatch = path.match(/^\/d(?:oc)?\/([0-9a-f-]+)\/versions$/i);
  if (versionsMatch && UUID_REGEX.test(versionsMatch[1])) {
    return { view: 'versions', docGuid: versionsMatch[1].toLowerCase() };
  }

  // Check for /d/{uuid} or /doc/{uuid} pattern
  const match = path.match(/^\/d(?:oc)?\/([0-9a-f-]+)$/i);
  if (match && UUID_REGEX.test(match[1])) {
    return { view: 'editor', docGuid: match[1].toLowerCase() };
  }

  // Root path shows landing page
  if (path === '/' || path === '') {
    return { view: 'landing', docGuid: null };
  }

  // Default to landing page for unknown routes
  return { view: 'landing', docGuid: null };
}

/**
 * Main app content - handles routing based on auth state
 */
function AppContent() {
  const { user, loading, isAuthenticated } = useAuth();
  const [route, setRoute] = useState(parseRoute);
  const [listKey, setListKey] = useState(0);
  const isMobile = useMobile();

  // Set data attributes on body for current view and mobile state (used for view-specific CSS)
  useEffect(() => {
    document.body.setAttribute('data-view', route.view);
    return () => {
      document.body.removeAttribute('data-view');
    };
  }, [route.view]);

  useEffect(() => {
    if (isMobile) {
      document.body.setAttribute('data-mobile', 'true');
    } else {
      document.body.removeAttribute('data-mobile');
    }
    return () => {
      document.body.removeAttribute('data-mobile');
    };
  }, [isMobile]);

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute());
      setListKey(k => k + 1); // Force DocList refresh on back navigation
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Navigate to a document
  const navigateToDoc = (docGuid) => {
    const newPath = `/d/${docGuid}`;
    window.history.pushState({}, '', newPath);
    setRoute({ view: 'editor', docGuid });
  };

  // Navigate to version history
  const navigateToVersions = (docGuid) => {
    const newPath = `/d/${docGuid}/versions`;
    window.history.pushState({}, '', newPath);
    setRoute({ view: 'versions', docGuid });
  };

  // Navigate to document list
  const navigateToDocs = () => {
    window.history.pushState({}, '', '/docs');
    setRoute({ view: 'list', docGuid: null });
    setListKey(k => k + 1); // Force DocList to refetch
  };

  // Navigate to landing page
  const navigateToLanding = () => {
    window.history.pushState({}, '', '/');
    setRoute({ view: 'landing', docGuid: null });
  };

  // Navigate to login page
  const navigateToLogin = () => {
    window.history.pushState({}, '', '/login');
    setRoute({ view: 'login', docGuid: null });
  };

  // Navigate to settings page
  const navigateToSettings = () => {
    window.history.pushState({}, '', '/settings');
    setRoute({ view: 'settings', docGuid: null });
  };

  // Show loading state during auth initialization
  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner"></div>
        <div>Loading...</div>
      </div>
    );
  }

  // Landing page - always public
  if (route.view === 'landing') {
    return (
      <LandingPage
        isAuthenticated={isAuthenticated}
        onNavigateToDocs={navigateToDocs}
        onNavigateToLogin={navigateToLogin}
      />
    );
  }

  // Authorization page - for OAuth agent authorization
  if (route.view === 'authorize') {
    return <AuthorizePage />;
  }

  // Login page - redirect to docs if already authenticated
  if (route.view === 'login') {
    if (isAuthenticated) {
      navigateToDocs();
      return null;
    }
    return <LoginPage onNavigateToLanding={navigateToLanding} />;
  }

  // Protected routes - require authentication
  if (!isAuthenticated) {
    return <LoginPage onNavigateToLanding={navigateToLanding} />;
  }

  return <AuthenticatedApp route={route} listKey={listKey} user={user}
    navigateToDocs={navigateToDocs} navigateToDoc={navigateToDoc}
    navigateToVersions={navigateToVersions} navigateToSettings={navigateToSettings} />;
}

/**
 * Authenticated shell — renders the current page plus the AI panel.
 * Separated so useAiPanel/useAiChat hooks are only called when logged in.
 */
function AuthenticatedApp({ route, listKey, user, navigateToDocs, navigateToDoc, navigateToVersions, navigateToSettings }) {
  const aiPanel = useAiPanel();
  const aiChat = useAiChat();
  const isMobile = useMobile();

  const aiPanelClass = aiPanel.isOpen && !isMobile && !aiPanel.isPoppedOut
    ? ` ai-panel-${aiPanel.position}` : '';

  let page;
  if (route.view === 'editor' && route.docGuid) {
    page = (
      <EditorView
        key={route.docGuid}
        docGuid={route.docGuid}
        onNavigateHome={navigateToDocs}
        onNavigateToVersions={navigateToVersions}
        onNavigateToSettings={navigateToSettings}
        showVersionHistory={false}
        user={user}
        aiPanel={aiPanel}
      />
    );
  } else if (route.view === 'versions' && route.docGuid) {
    page = (
      <EditorView
        key={`${route.docGuid}-versions`}
        docGuid={route.docGuid}
        onNavigateHome={navigateToDocs}
        onNavigateToVersions={navigateToVersions}
        onNavigateToSettings={navigateToSettings}
        showVersionHistory={true}
        user={user}
        aiPanel={aiPanel}
      />
    );
  } else if (route.view === 'settings') {
    page = <SettingsPage onNavigateHome={navigateToDocs} user={user} />;
  } else {
    page = <DocList key={listKey} onNavigate={navigateToDoc} onNavigateToSettings={navigateToSettings} user={user} />;
  }

  return (
    <div className={`app-shell${route.view === 'versions' ? ' version-history-mode' : ''}`}>
      <div className={`app-body${aiPanelClass}`}>
        <div className="app-content">
          {page}
        </div>
        <AiPanel aiPanel={aiPanel} aiChat={aiChat} />
      </div>
      {/* Floating AI toggle — consistent across all pages */}
      <button
        className={`ai-fab${aiPanel.isOpen ? ' ai-fab--active' : ''}`}
        onClick={aiPanel.isPoppedOut ? aiPanel.focusPopup : aiPanel.toggle}
        aria-label="AI Assistant"
        title="AI Assistant"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z" />
          <path d="M5 19l1.5-3L10 15" opacity="0.6" />
          <path d="M19 19l-1.5-3L14 15" opacity="0.6" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Root App component with AuthProvider
 */
function App() {
  return (
    <AuthProvider>
      <AiChatProvider>
        <AppContent />
      </AiChatProvider>
    </AuthProvider>
  );
}

export default App;
