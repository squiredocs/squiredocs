import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import DocList from './components/DocList';
import EditorView from './components/EditorView';
import LoginPage from './components/LoginPage';
import './App.css';

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parse the current URL to determine the view
function parseRoute() {
  const path = window.location.pathname;
  
  // Check for /login path
  if (path === '/login') {
    return { view: 'login', docGuid: null };
  }
  
  // Check for /d/{uuid} or /doc/{uuid} pattern
  const match = path.match(/^\/d(?:oc)?\/([0-9a-f-]+)$/i);
  if (match && UUID_REGEX.test(match[1])) {
    return { view: 'editor', docGuid: match[1].toLowerCase() };
  }
  
  // Default to document list
  return { view: 'list', docGuid: null };
}

/**
 * Main app content - handles routing based on auth state
 */
function AppContent() {
  const { user, loading, isAuthenticated } = useAuth();
  const [route, setRoute] = useState(parseRoute);
  const [listKey, setListKey] = useState(0);

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

  // Navigate to home (document list)
  const navigateHome = () => {
    window.history.pushState({}, '', '/');
    setRoute({ view: 'list', docGuid: null });
    setListKey(k => k + 1); // Force DocList to refetch
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

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return <LoginPage />;
  }

  // Authenticated - show app content
  if (route.view === 'editor' && route.docGuid) {
    return (
      <EditorView 
        key={route.docGuid} 
        docGuid={route.docGuid} 
        onNavigateHome={navigateHome}
        user={user}
      />
    );
  }

  return <DocList key={listKey} onNavigate={navigateToDoc} user={user} />;
}

/**
 * Root App component with AuthProvider
 */
function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
