import React, { useState, useEffect, useRef } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AiChatProvider, useAiChat } from './contexts/AiChatContext';
import { useAiPanel } from './hooks/useAiPanel';
import { ByokProvider } from './contexts/ByokContext';
import { useMobile } from './hooks/useMobile';
import DocList from './components/DocList';
import EditorView from './components/EditorView';
import AiPanel from './components/AiPanel';
import LoginPage from './components/LoginPage';
import AuthorizePage, { AuthorizePreview } from './pages/AuthorizePage';
import SettingsPage from './pages/SettingsPage';
import SupportPage from './pages/SupportPage';
import AdminPage from './pages/AdminPage';
import ChatPage from './pages/ChatPage';
import PrivacyPage from './pages/PrivacyPage';
import TermsPage from './pages/TermsPage';
import './App.css';

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parse the current URL to determine the view
function parseRoute() {
  const path = window.location.pathname;

  // Check for /authorize path (OAuth agent authorization)
  if (path === '/authorize-preview') {
    return { view: 'authorize-preview', docGuid: null };
  }
  if (path === '/authorize') {
    return { view: 'authorize', docGuid: null };
  }

  // Check for /login or /signup path
  if (path === '/login') {
    return { view: 'login', docGuid: null };
  }
  if (path === '/signup') {
    return { view: 'signup', docGuid: null };
  }

  // Check for /settings path
  if (path === '/settings') {
    return { view: 'settings', docGuid: null };
  }

  // Check for /support path
  if (path === '/support') {
    return { view: 'support', docGuid: null };
  }

  // Public legal pages (no auth required)
  if (path === '/privacy') {
    return { view: 'privacy', docGuid: null };
  }
  if (path === '/terms') {
    return { view: 'terms', docGuid: null };
  }

  // /admin path — parsed here but gated on isAdmin in AppContent
  if (path === '/admin') {
    return { view: 'admin', docGuid: null };
  }

  // Chat-centric view
  if (path === '/chat') {
    return { view: 'chat', docGuid: null };
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

  // Track SPA page views in Google Analytics
  useEffect(() => {
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'page_view', {
        page_path: window.location.pathname,
        page_title: document.title,
      });
    }
  }, [route.view, route.docGuid]);

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

  // Navigate to the user's welcome doc and trigger the onboarding flow
  // (?welcome=1 → AuthenticatedApp opens the panel + the assistant greets).
  const navigateToWelcome = (docGuid) => {
    window.history.pushState({}, '', `/d/${docGuid}?welcome=1`);
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

  // Navigate to login page
  const navigateToLogin = () => {
    window.history.pushState({}, '', '/login');
    setRoute({ view: 'login', docGuid: null });
  };

  // Navigate to signup page
  const navigateToSignup = () => {
    window.history.pushState({}, '', '/signup');
    setRoute({ view: 'signup', docGuid: null });
  };

  // Navigate to settings page
  const navigateToSettings = () => {
    window.history.pushState({}, '', '/settings');
    setRoute({ view: 'settings', docGuid: null });
  };

  // Navigate to support page
  const navigateToSupport = () => {
    window.history.pushState({}, '', '/support');
    setRoute({ view: 'support', docGuid: null });
  };

  // Navigate to admin page
  const navigateToAdmin = () => {
    window.history.pushState({}, '', '/admin');
    setRoute({ view: 'admin', docGuid: null });
  };

  const navigateToChat = () => {
    window.history.pushState({}, '', '/chat');
    setRoute({ view: 'chat', docGuid: null });
  };

  // Public legal pages - static content, available signed in or out and
  // independent of auth state (rendered before the auth-loading gate).
  if (route.view === 'privacy') {
    return <PrivacyPage />;
  }
  if (route.view === 'terms') {
    return <TermsPage />;
  }

  // Show loading state during auth initialization
  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner"></div>
        <div>Loading...</div>
      </div>
    );
  }

  // Landing page - redirect to welcome doc (not-yet-onboarded), docs, or signup
  if (route.view === 'landing') {
    if (isAuthenticated) {
      if (user && user.onboarded === false && user.welcomeDocId) {
        navigateToWelcome(user.welcomeDocId);
      } else {
        navigateToDocs();
      }
    } else {
      navigateToSignup();
    }
    return null;
  }

  // Authorization preview - shows the page with fake data
  if (route.view === 'authorize-preview') {
    return <AuthorizePreview />;
  }

  // Authorization page - for OAuth agent authorization
  if (route.view === 'authorize') {
    return <AuthorizePage />;
  }

  // Signup page - redirect to docs if already authenticated
  if (route.view === 'signup') {
    if (isAuthenticated) {
      navigateToDocs();
      return null;
    }
    return <LoginPage onNavigateToSignup={navigateToSignup} onNavigateToLogin={navigateToLogin} mode="signup" />;
  }

  // Login page - redirect to docs if already authenticated
  if (route.view === 'login') {
    if (isAuthenticated) {
      navigateToDocs();
      return null;
    }
    return <LoginPage onNavigateToSignup={navigateToSignup} onNavigateToLogin={navigateToLogin} mode="login" />;
  }

  // Admin page — non-admins get redirected to docs (same as unknown route)
  if (route.view === 'admin' && (!isAuthenticated || !user?.isAdmin)) {
    if (isAuthenticated) {
      navigateToDocs();
    } else {
      navigateToSignup();
    }
    return null;
  }

  // Protected routes - require authentication
  if (!isAuthenticated) {
    return <LoginPage onNavigateToSignup={navigateToSignup} onNavigateToLogin={navigateToLogin} mode="login" />;
  }

  return (
    <ByokProvider>
      <AuthenticatedApp route={route} listKey={listKey} user={user}
        navigateToDocs={navigateToDocs} navigateToDoc={navigateToDoc}
        navigateToVersions={navigateToVersions} navigateToSettings={navigateToSettings}
        navigateToSupport={navigateToSupport}
        navigateToAdmin={navigateToAdmin} navigateToChat={navigateToChat} />
    </ByokProvider>
  );
}

/**
 * Authenticated shell — renders the current page plus the AI panel.
 * Separated so useAiPanel/useAiChat hooks are only called when logged in.
 */
function AuthenticatedApp({ route, listKey, user, navigateToDocs, navigateToDoc, navigateToVersions, navigateToSettings, navigateToSupport, navigateToAdmin, navigateToChat }) {
  const aiPanel = useAiPanel();
  const aiChat = useAiChat();
  const isMobile = useMobile();
  const lastDocGuidRef = useRef(null);
  const prevViewRef = useRef(route.view);
  const welcomeStartedRef = useRef(false);

  // Track most recently viewed document for chat↔editor toggle
  if (route.view === 'editor' && route.docGuid) {
    lastDocGuidRef.current = route.docGuid;
  }

  // When returning from chat to editor, auto-open the AI panel so the conversation stays visible
  useEffect(() => {
    if (prevViewRef.current === 'chat' && route.view === 'editor') {
      aiPanel.open();
    }
    prevViewRef.current = route.view;
  }, [route.view, aiPanel.open]);

  // Onboarding: landing on the welcome doc (?welcome=1) opens the AI panel and
  // has the assistant greet the user. Fires exactly once, then strips the flag
  // so a refresh or back-nav doesn't re-trigger the greeting.
  useEffect(() => {
    if (welcomeStartedRef.current) return;
    if (route.view !== 'editor' || !route.docGuid) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('welcome') !== '1') return;

    welcomeStartedRef.current = true;
    aiPanel.open();
    aiChat.sendWelcomeMessage();

    params.delete('welcome');
    const qs = params.toString();
    window.history.replaceState({}, '', `/d/${route.docGuid}${qs ? `?${qs}` : ''}`);
  }, [route.view, route.docGuid, aiPanel.open, aiChat.sendWelcomeMessage]);

  const aiPanelClass = aiPanel.isOpen && !isMobile
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
        onNavigateToSupport={navigateToSupport}
        onNavigateToAdmin={user?.isAdmin ? navigateToAdmin : null}
        onNavigateToChat={navigateToChat}
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
        onNavigateToSupport={navigateToSupport}
        onNavigateToAdmin={user?.isAdmin ? navigateToAdmin : null}
        onNavigateToChat={navigateToChat}
        showVersionHistory={true}
        user={user}
        aiPanel={aiPanel}
      />
    );
  } else if (route.view === 'settings') {
    page = <SettingsPage onNavigateHome={navigateToDocs} onNavigateToSettings={navigateToSettings} onNavigateToSupport={navigateToSupport} onNavigateToAdmin={user?.isAdmin ? navigateToAdmin : null} onNavigateToChat={navigateToChat} user={user} />;
  } else if (route.view === 'support') {
    page = <SupportPage onNavigateHome={navigateToDocs} onNavigateToSettings={navigateToSettings} onNavigateToSupport={navigateToSupport} onNavigateToAdmin={user?.isAdmin ? navigateToAdmin : null} onNavigateToChat={navigateToChat} user={user} />;
  } else if (route.view === 'admin') {
    page = <AdminPage onNavigateHome={navigateToDocs} onNavigateToSettings={navigateToSettings} onNavigateToSupport={navigateToSupport} onNavigateToChat={navigateToChat} user={user} />;
  } else if (route.view === 'chat') {
    page = <ChatPage user={user} onNavigateHome={navigateToDocs} onNavigateToSettings={navigateToSettings} onNavigateToSupport={navigateToSupport} onNavigateToDoc={navigateToDoc} onNavigateBack={(docGuid) => { docGuid ? navigateToDoc(docGuid) : navigateToDocs(); }} initialDocGuid={prevViewRef.current === 'editor' ? lastDocGuidRef.current : null} />;
  } else {
    page = <DocList key={listKey} onNavigate={navigateToDoc} onNavigateToSettings={navigateToSettings} onNavigateToSupport={navigateToSupport} onNavigateToAdmin={user?.isAdmin ? navigateToAdmin : null} onNavigateToChat={navigateToChat} user={user} />;
  }

  const isChatPage = route.view === 'chat';

  // Chat page manages its own full-page layout — skip the app shell wrapper
  if (isChatPage) return page;

  return (
    <div className={`app-shell${route.view === 'versions' ? ' version-history-mode' : ''}`}>
      <div className={`app-body${aiPanelClass}`}>
        <div className="app-content">
          {page}
        </div>
        <AiPanel aiPanel={aiPanel} aiChat={aiChat} onNavigateToChat={navigateToChat} onNavigateToDoc={navigateToDoc} docGuid={route.docGuid} />
      </div>
      {/* Floating AI toggle — consistent across all pages */}
      <button
        className={`ai-fab${aiPanel.isOpen ? ' ai-fab--active' : ''}`}
        onClick={aiPanel.toggle}
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
