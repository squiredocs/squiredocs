import React, { useState, useEffect } from 'react';
import DocList from './components/DocList';
import EditorView from './components/EditorView';
import './App.css';

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parse the current URL to determine the view
function parseRoute() {
  const path = window.location.pathname;
  
  // Check for /d/{uuid} or /doc/{uuid} pattern
  const match = path.match(/^\/d(?:oc)?\/([0-9a-f-]+)$/i);
  if (match && UUID_REGEX.test(match[1])) {
    return { view: 'editor', docGuid: match[1].toLowerCase() };
  }
  
  // Default to document list
  return { view: 'list', docGuid: null };
}

function App() {
  const [route, setRoute] = useState(parseRoute);

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute());
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
  };

  if (route.view === 'editor' && route.docGuid) {
    return (
      <EditorView 
        key={route.docGuid} 
        docGuid={route.docGuid} 
        onNavigateHome={navigateHome} 
      />
    );
  }

  return <DocList onNavigate={navigateToDoc} />;
}

export default App;
