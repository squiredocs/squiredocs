/**
 * Cursor animator
 * Plays back cursor animations based on tracked operations
 * Provides visual feedback in the UI for agent edits
 */

const { createCursorPositionFromPath } = require('../yjs/cursor-operations');

/**
 * Plays cursor animation sequence for a session
 * @param {object} session - Agent session with provider and awareness
 * @param {Y.XmlFragment} xmlFragment - Document fragment
 * @param {Array<object>} cursorSequence - Cursor animation steps from operation tracker
 * @returns {Promise<void>}
 */
async function animateCursor(session, xmlFragment, cursorSequence) {
  if (!cursorSequence || cursorSequence.length === 0) {
    return;
  }

  // Run animation asynchronously (non-blocking)
  // We don't await this - it runs in the background
  playSequence(session, xmlFragment, cursorSequence).catch(error => {
    console.error('[cursor-animator] Animation error:', error);
  });
}

/**
 * Plays a cursor animation sequence
 * @param {object} session - Agent session
 * @param {Y.XmlFragment} xmlFragment - Document fragment
 * @param {Array<object>} sequence - Animation steps
 * @returns {Promise<void>}
 * @private
 */
async function playSequence(session, xmlFragment, sequence) {
  const agentPresence = require('../agent-presence');

  for (const step of sequence) {
    try {
      await playStep(session, xmlFragment, step, agentPresence);
    } catch (error) {
      console.error('[cursor-animator] Step error:', error.message);
      // Continue with next step even if one fails
    }
  }

  // Clear cursor at the end
  try {
    agentPresence.updateSessionCursor(session.sessionId, null, null);
  } catch (error) {
    // Ignore errors clearing cursor
  }
}

/**
 * Plays a single animation step
 * @param {object} session - Agent session
 * @param {Y.XmlFragment} xmlFragment - Document fragment
 * @param {object} step - Animation step
 * @param {object} agentPresence - Agent presence module
 * @returns {Promise<void>}
 * @private
 */
async function playStep(session, xmlFragment, step, agentPresence) {
  switch (step.type) {
    case 'insert': {
      // Animate text insertion - show cursor moving as text is "typed"
      const { path, offset, text, duration } = step;

      // Create cursor at start position
      try {
        const startPos = createCursorPositionFromPath(xmlFragment, path, offset);
        agentPresence.updateSessionCursor(session.sessionId, startPos, startPos);

        // If text is short, just show it appearing
        if (text.length <= 3 || duration < 100) {
          await sleep(duration);
          return;
        }

        // For longer text, animate cursor moving
        const steps = Math.min(text.length, 10); // Max 10 animation steps
        const stepDuration = duration / steps;
        const charsPerStep = Math.ceil(text.length / steps);

        for (let i = 1; i <= steps; i++) {
          const currentOffset = offset + Math.min(i * charsPerStep, text.length);
          const currentPos = createCursorPositionFromPath(xmlFragment, path, currentOffset);
          agentPresence.updateSessionCursor(session.sessionId, currentPos, currentPos);
          await sleep(stepDuration);
        }
      } catch (error) {
        // Path might be invalid after document changes
        console.error('[cursor-animator] Insert animation error:', error.message);
      }
      break;
    }

    case 'delete': {
      // Animate text deletion - show selection over deleted region
      const { path, offset, length, duration } = step;

      try {
        const startPos = createCursorPositionFromPath(xmlFragment, path, offset);
        const endPos = createCursorPositionFromPath(xmlFragment, path, offset + length);

        // Show selection
        agentPresence.updateSessionCursor(session.sessionId, startPos, endPos);
        await sleep(duration);

        // Collapse to start
        agentPresence.updateSessionCursor(session.sessionId, startPos, startPos);
      } catch (error) {
        console.error('[cursor-animator] Delete animation error:', error.message);
      }
      break;
    }

    case 'format': {
      // Animate formatting - flash selection over formatted region
      const { path, offset, length, duration } = step;

      try {
        const startPos = createCursorPositionFromPath(xmlFragment, path, offset);
        const endPos = createCursorPositionFromPath(xmlFragment, path, offset + length);

        // Show selection
        agentPresence.updateSessionCursor(session.sessionId, startPos, endPos);
        await sleep(duration);

        // Collapse to end
        agentPresence.updateSessionCursor(session.sessionId, endPos, endPos);
      } catch (error) {
        console.error('[cursor-animator] Format animation error:', error.message);
      }
      break;
    }

    case 'insert_block':
    case 'delete_block':
    case 'set_attribute': {
      // For block operations, just pause briefly
      await sleep(step.duration || 200);
      break;
    }

    default:
      // Unknown step type, skip
      break;
  }
}

/**
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { animateCursor };
