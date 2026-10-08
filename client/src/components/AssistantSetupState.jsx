import React from 'react';
import { spaNavigate } from '../utils/navigation';
import './AssistantSetupState.css';

// Where the "Open Settings" button lands: the Bring Your Own Key subsection.
export const ASSISTANT_KEY_SETTINGS_PATH = '/settings#assistant-key';

/**
 * Static setup state for the in-app assistant when it can't answer this user:
 * no shared server key on the instance and no complete BYOK setup (a fresh
 * self-hosted install). Shown by both chat surfaces in place of the composer, so
 * no turn (including the hidden welcome kickoff) is sent while it is up.
 *
 * The .env line is shown only to an admin, who is the person who runs the
 * instance (the claimed owner of a self-hosted install is an admin).
 *
 * @param {object} props
 * @param {boolean} [props.isAdmin]     Show the instance-wide key instructions.
 * @param {Function} [props.onNavigate] Called after navigating to Settings (the
 *   mobile panel closes itself so Settings isn't hidden under the overlay).
 * @param {boolean} [props.compact]     Messages are shown above; don't take the full height.
 */
function AssistantSetupState({ isAdmin = false, onNavigate, compact = false }) {
  const openSettings = () => {
    spaNavigate(ASSISTANT_KEY_SETTINGS_PATH);
    onNavigate?.();
  };

  return (
    <div className={`assistant-setup${compact ? ' assistant-setup--compact' : ''}`} role="status" data-testid="assistant-setup">
      <h3 className="assistant-setup-title">The Squire Docs assistant needs an AI key</h3>
      <p className="assistant-setup-text">
        Add your own key in Settings, turn on Use my key, and pick a model. Then you can chat here.
      </p>
      <button type="button" className="assistant-setup-btn" onClick={openSettings}>
        Open Settings
      </button>
      {isAdmin && (
        <p className="assistant-setup-text assistant-setup-admin" data-testid="assistant-setup-admin">
          To turn it on for everyone on this instance, set <code>ANTHROPIC_API_KEY</code> or{' '}
          <code>OPENROUTER_API_KEY</code> in the instance&apos;s <code>.env</code> file and restart
          with <code>docker compose up -d</code>.
        </p>
      )}
      <p className="assistant-setup-text assistant-setup-note">
        Coding agents connected over MCP work without a key. The Connect your coding agents
        section of your Welcome document shows how.
      </p>
    </div>
  );
}

export default AssistantSetupState;
