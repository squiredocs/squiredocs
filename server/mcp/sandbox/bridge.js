/**
 * Bridge module — Host-side orchestration for worker thread execution
 *
 * Spawns a worker thread to execute user scripts in a separate V8 isolate,
 * then applies incremental Y.Doc updates back to the live document.
 * Preserves real-time streaming: cursor animations, highlight sequences,
 * and atomic error rollback (all of one execution's updates grouped into one
 * stack item on a transient, execution-scoped UndoManager — the
 * session-lifetime UndoManager is retired; feature 016).
 */

const { Worker } = require('worker_threads');
const path = require('path');
const Y = require('yjs');
const { createOperationSelection } = require('../yjs/cursor-operations');
const { validateDocumentSchema } = require('../yjs/validation');
const agentPresence = require('../agent-presence');
const { MutationAggregator } = require('../mutation-aggregator');

// Grace period added to timeout for worker termination
const TIMEOUT_GRACE_MS = 2000;

/**
 * Execute compiled JavaScript in an isolated worker thread
 *
 * @param {string} jsCode - Compiled JavaScript code
 * @param {object} session - Agent session (contains provider, ydoc, sessionId)
 * @param {Y.XmlFragment} xmlFragment - Live document fragment to edit
 * @param {object} options - Execution options
 * @param {number} [options.timeout=5000] - Execution timeout in milliseconds
 * @param {Array<{docGuid: string, snapshot: Buffer}>} [options.sources] - Read-only
 *   source document snapshots exposed to the script as the `sources` global.
 *   Sources never stream updates back — ops/rollback/undo stay target-only.
 * @returns {Promise<object>} - { success, operationCount, summary, error }
 */
function executeInWorker(jsCode, session, xmlFragment, options = {}) {
  const { timeout = 5000, sources = [] } = options;

  return new Promise((resolve) => {
    const ydoc = session.provider.doc;

    // 1. Encode snapshot of current document state
    const snapshot = Y.encodeStateAsUpdate(ydoc);

    // 2. Rollback manager: a TRANSIENT Y.UndoManager scoped to this execution
    //    only. The session-lifetime UndoManager is retired (feature 016 —
    //    undo/redo are log-derived), but modify's atomicity contract stands:
    //    every incremental update from the worker is tagged with this
    //    execution's sandboxOrigin and merged into ONE stack item, so a script
    //    error or timeout rolls the whole edit back as a unit. The manager is
    //    destroyed in cleanup — it never outlives the call, and it can never
    //    merge with (or revert) an earlier modify's changes.
    const sandboxOrigin = 'sandbox-exec-' + Date.now();
    const undoManager = new Y.UndoManager(xmlFragment, {
      trackedOrigins: new Set([sandboxOrigin]),
      captureTimeout: timeout + TIMEOUT_GRACE_MS + 5000,
    });

    // Track total operation count from streamed messages
    let totalOperationCount = 0;
    let finalSummary = {};

    // Flag to prevent recursive onOperation calls during cursor position creation
    let inCursorCreation = false;

    // 3. Create mutation aggregator for visual feedback (same config as inline execution)
    const mutationAggregator = new MutationAggregator({
      sessionId: session.sessionId,
      xmlFragment,
      windowMs: 200,
      onFlush: (spans) => {
        const clearedCount = agentPresence.clearHighlightQueue(session.sessionId);
        if (clearedCount > 0) {
          console.log(`[Bridge] Clearing ${clearedCount} pending XPath highlights`);
        }
        agentPresence.queueHighlightSequence(session.sessionId, spans, 80, 240);
      },
    });

    // 4. Spawn worker with resource limits
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: {
        snapshot: Buffer.from(snapshot),
        jsCode,
        timeout,
        sources,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        codeRangeSizeMb: 16,
      },
    });

    // 5. Set external timeout timer
    let terminated = false;
    const timeoutTimer = setTimeout(() => {
      terminated = true;
      worker.terminate();
    }, timeout + TIMEOUT_GRACE_MS);

    // Cleanup helper
    function cleanup() {
      clearTimeout(timeoutTimer);
      undoManager.destroy();
      mutationAggregator.destroy();
    }

    // Rollback helper — one undo() call reverses all grouped updates
    function rollback() {
      if (undoManager.canUndo()) {
        undoManager.undo();
      }
    }

    // 6. Process messages from worker
    worker.on('message', (msg) => {
      try {
        switch (msg.type) {
          case 'ops': {
            // Apply incremental Y.Doc update to live document
            const update = new Uint8Array(msg.update);
            Y.applyUpdate(ydoc, update, sandboxOrigin);

            // Create cursor selections for each operation (visual feedback)
            for (const op of msg.operations) {
              totalOperationCount++;

              if (inCursorCreation) continue;

              try {
                inCursorCreation = true;
                const selection = createOperationSelection(xmlFragment, op);
                if (selection) {
                  mutationAggregator.addMutation({
                    ...selection,
                    timestamp: op.timestamp,
                  });
                }
              } catch (err) {
                console.warn('[Bridge] cursor creation error:', err.message);
              } finally {
                inCursorCreation = false;
              }
            }
            break;
          }

          case 'highlights': {
            // Forward highlight positions to agent presence
            agentPresence.queueHighlightSequence(session.sessionId, msg.positions);
            break;
          }

          case 'complete': {
            totalOperationCount = msg.operationCount || totalOperationCount;
            finalSummary = msg.summary || {};
            // Worker will exit after this — handled in 'exit' event
            break;
          }

          case 'error': {
            // Worker reported an error — roll back all changes
            mutationAggregator.flush();
            rollback();
            cleanup();

            resolve({
              success: false,
              error: msg.error,
              operationCount: msg.operationCount || totalOperationCount,
            });
            break;
          }
        }
      } catch (err) {
        console.error('[Bridge] Error processing worker message:', err);
      }
    });

    // 7. Handle worker exit
    worker.on('exit', async (code) => {
      try {
        // Flush any remaining aggregated mutations
        await mutationAggregator.flush();

        if (terminated) {
          // Worker was killed due to timeout — roll back
          rollback();
          cleanup();
          resolve({
            success: false,
            error: `Script execution timed out after ${timeout}ms.\nHint: Check for infinite loops or long-running operations.`,
            operationCount: totalOperationCount,
          });
          return;
        }

        if (code !== 0) {
          // Worker crashed — roll back
          rollback();
          cleanup();
          resolve({
            success: false,
            error: `Worker exited with code ${code}`,
            operationCount: totalOperationCount,
          });
          return;
        }

        // Validate document schema
        const validation = validateDocumentSchema(xmlFragment);
        if (!validation.valid) {
          rollback();
          cleanup();
          resolve({
            success: false,
            error: `Script produced invalid document structure (changes rolled back). ${validation.error}. Common cause: inserting nodes into the wrong container (e.g. 'paragraph' directly inside 'bulletList' requires a 'listItem' wrapper).`,
            operationCount: totalOperationCount,
          });
          return;
        }

        cleanup();
        resolve({
          success: true,
          operationCount: totalOperationCount,
          summary: finalSummary,
        });
      } catch (err) {
        cleanup();
        resolve({
          success: false,
          error: err.message,
          operationCount: totalOperationCount,
        });
      }
    });

    // 8. Handle worker errors (e.g., failed to spawn)
    worker.on('error', (err) => {
      rollback();
      cleanup();
      resolve({
        success: false,
        error: err.message,
        operationCount: totalOperationCount,
      });
    });
  });
}

module.exports = { executeInWorker };
