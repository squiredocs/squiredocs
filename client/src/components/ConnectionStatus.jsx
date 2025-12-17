import './ConnectionStatus.css';

export default function ConnectionStatus({ connected, connectionState, onRetry, reconnectCount }) {
  // Use new connectionState if available, otherwise fall back to connected boolean
  const state = connectionState || (connected ? 'connected' : 'disconnected');

  const getStatusText = () => {
    switch (state) {
      case 'connecting':
        return reconnectCount > 0 ? `Reconnecting... (${reconnectCount})` : 'Connecting...';
      case 'connected':
        return 'Connected';
      case 'disconnected':
        return 'Disconnected';
      default:
        return state;
    }
  };

  return (
    <div className={`connection-status ${state}`}>
      <span className="connection-status-dot" />
      <span className="connection-status-text">
        {getStatusText()}
      </span>
      {state === 'disconnected' && onRetry && (
        <button
          className="connection-status-retry"
          onClick={onRetry}
          title="Retry connection"
        >
          Retry
        </button>
      )}
    </div>
  );
}

