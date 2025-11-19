import './ConnectionStatus.css';

export default function ConnectionStatus({ connected }) {
  return (
    <div className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
      <span className="connection-status-dot" />
      <span className="connection-status-text">
        {connected ? 'Connected' : 'Disconnected'}
      </span>
    </div>
  );
}

