import React, { useEffect, useState } from 'react';
import './DocList.css';

function DocList({ onNavigate }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchDocs();
  }, []);

  const fetchDocs = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/docs');
      
      // Check content-type to ensure we're getting JSON
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error('Server returned non-JSON response. Make sure the backend is running.');
      }
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server error: ${response.status}`);
      }
      
      const data = await response.json();
      setDocs(data.docs || []);
    } catch (err) {
      console.error('Error fetching docs:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateNew = () => {
    // Generate a new UUID and navigate to it
    const newGuid = crypto.randomUUID();
    onNavigate(newGuid);
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (loading) {
    return (
      <div className="doc-list-container">
        <div className="doc-list-loading">Loading documents...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="doc-list-container">
        <div className="doc-list-error">
          <p>Error: {error}</p>
          <button onClick={fetchDocs}>Try Again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="doc-list-container">
      <header className="doc-list-header">
        <h1>Documents</h1>
        <button className="create-doc-btn" onClick={handleCreateNew}>
          + New Document
        </button>
      </header>

      {docs.length === 0 ? (
        <div className="doc-list-empty">
          <p>No documents yet.</p>
          <p>Create your first document to get started!</p>
        </div>
      ) : (
        <ul className="doc-list">
          {docs.map((doc) => (
            <li key={doc.docGuid} className="doc-list-item">
              <a
                href={`/d/${doc.docGuid}`}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(doc.docGuid);
                }}
                className="doc-link"
              >
                <span className="doc-title">
                  {doc.title || 'Untitled Document'}
                </span>
                <span className="doc-date">
                  {formatDate(doc.updatedAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default DocList;

