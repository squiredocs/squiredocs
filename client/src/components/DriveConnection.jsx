/**
 * DriveConnection
 *
 * Manages the user's Google Drive connection in Settings.
 * Handles connect, disconnect, and status display.
 */
import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function DriveConnection() {
  const { api } = useAuth();
  const [connection, setConnection] = useState(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  useEffect(() => {
    fetchConnection();

    // Check for redirect result from OAuth flow
    const params = new URLSearchParams(window.location.search);
    const driveParam = params.get('drive');
    if (driveParam === 'connected') {
      setSuccessMessage('Google Drive connected successfully.');
      // Clean the URL
      const url = new URL(window.location);
      url.searchParams.delete('drive');
      window.history.replaceState({}, '', url.pathname + url.search);
    } else if (driveParam === 'error') {
      const reason = params.get('reason') || 'unknown';
      const messages = {
        account_mismatch: 'The Google account you selected does not match your login account.',
        invalid_state: 'Authorization expired. Please try again.',
        auth_failed: 'Authorization failed. Please try again.',
        config: 'Google Drive is not configured on this server.',
      };
      setError(messages[reason] || `Connection failed: ${reason}`);
      const url = new URL(window.location);
      url.searchParams.delete('drive');
      url.searchParams.delete('reason');
      window.history.replaceState({}, '', url.pathname + url.search);
    }
  }, []);

  async function fetchConnection() {
    try {
      const res = await api.get('/api/settings/connected-services');
      const drive = res.data.services?.find((s) => s.service === 'google_drive');
      setConnection(drive || null);
    } catch (err) {
      // Not fatal — just means we can't check status
      setConnection(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect Google Drive? You can reconnect at any time.')) return;
    setDisconnecting(true);
    setError(null);
    try {
      await api.delete('/api/settings/connected-services/google_drive');
      setConnection(null);
      setSuccessMessage('Google Drive disconnected.');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to disconnect.');
    } finally {
      setDisconnecting(false);
    }
  }

  function handleConnect() {
    // Navigate to the OAuth flow (server-side redirect)
    window.location.href = '/auth/google/drive';
  }

  if (loading) {
    return <div className="drive-connection-loading">Loading...</div>;
  }

  const isExpiringSoon =
    connection?.expires_at &&
    new Date(connection.expires_at) < new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const isExpired =
    connection?.expires_at && new Date(connection.expires_at) < new Date();
  const isError = connection?.token_status === 'error';

  return (
    <div className="drive-connection">
      {error && <div className="drive-connection-error">{error}</div>}
      {successMessage && (
        <div className="drive-connection-success">{successMessage}</div>
      )}

      {!connection ? (
        <div className="drive-connection-disconnected">
          <p className="drive-connection-description">
            Connect Google Drive to export Squire documents to Google Docs
            and import Google Docs for editing.
          </p>
          <button className="drive-connection-btn connect" onClick={handleConnect}>
            Connect Google Drive
          </button>
        </div>
      ) : (
        <div className="drive-connection-connected">
          <div className="drive-connection-status-row">
            <div className="drive-connection-info">
              <span className="drive-connection-email">{connection.service_email}</span>
              {isError ? (
                <span className="drive-connection-badge error">Needs reconnection</span>
              ) : isExpired ? (
                <span className="drive-connection-badge expired">Expired</span>
              ) : isExpiringSoon ? (
                <span className="drive-connection-badge expiring">Expiring soon</span>
              ) : (
                <span className="drive-connection-badge active">Connected</span>
              )}
            </div>
            <div className="drive-connection-actions">
              {(isError || isExpired || isExpiringSoon) && (
                <button className="drive-connection-btn connect" onClick={handleConnect}>
                  {isError || isExpired ? 'Reconnect' : 'Renew'}
                </button>
              )}
              <button
                className="drive-connection-btn disconnect"
                onClick={handleDisconnect}
                disabled={disconnecting}
              >
                {disconnecting ? 'Disconnecting...' : 'Disconnect'}
              </button>
            </div>
          </div>
          {connection.error_message && (
            <p className="drive-connection-error-detail">{connection.error_message}</p>
          )}
        </div>
      )}
    </div>
  );
}
