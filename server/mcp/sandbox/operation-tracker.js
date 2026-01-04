/**
 * Operation tracker
 * Records all Yjs operations performed during script execution
 * Used for generating operation summaries and cursor animations
 */

/**
 * Tracks operations performed on Yjs document
 */
class OperationTracker {
  constructor() {
    /**
     * Array of recorded operations
     * @type {Array<{type: string, target: string, path: number[], args: any[], timestamp: number}>}
     */
    this.operations = [];
  }

  /**
   * Records a mutation operation
   * @param {object} operation - Operation details
   * @param {string} operation.type - Operation type (insert, delete, format, etc.)
   * @param {string} operation.target - Target Yjs type (XmlFragment, XmlElement, XmlText)
   * @param {number[]} operation.path - Path in document tree
   * @param {any[]} operation.args - Operation arguments
   * @param {number} operation.timestamp - Operation timestamp
   */
  record(operation) {
    this.operations.push({
      type: operation.type,
      target: operation.target,
      path: operation.path,
      args: operation.args,
      timestamp: operation.timestamp,
    });
  }

  /**
   * Gets total count of operations
   * @returns {number}
   */
  getOperationCount() {
    return this.operations.length;
  }

  /**
   * Gets operations grouped by type
   * @returns {object} - Map of operation type to count
   */
  getOperationSummary() {
    const summary = {};
    for (const op of this.operations) {
      summary[op.type] = (summary[op.type] || 0) + 1;
    }
    return summary;
  }

  /**
   * Generates a cursor animation sequence from recorded operations
   * This converts Yjs operations into cursor movements for visual feedback
   * @returns {Array<object>} - Array of cursor animation steps
   */
  generateCursorSequence() {
    const sequence = [];

    for (const op of this.operations) {
      const step = this._operationToCursorStep(op);
      if (step) {
        sequence.push(step);
      }
    }

    return sequence;
  }

  /**
   * Converts a single operation to a cursor animation step
   * @param {object} op - Operation
   * @returns {object|null} - Cursor step or null if not animatable
   * @private
   */
  _operationToCursorStep(op) {
    switch (op.type) {
      case 'insert': {
        // For text insertion
        if (op.target === 'XmlText') {
          const [offset, text] = op.args;
          return {
            type: 'insert',
            path: op.path,
            offset,
            text,
            duration: Math.min(text.length * 50, 2000), // 50ms per char, max 2s
          };
        }

        // For block insertion
        return {
          type: 'insert_block',
          path: op.path,
          index: op.args[0],
          duration: 300,
        };
      }

      case 'delete': {
        // For text deletion
        if (op.target === 'XmlText') {
          const [offset, length] = op.args;
          return {
            type: 'delete',
            path: op.path,
            offset,
            length,
            duration: 200,
          };
        }

        // For block deletion
        return {
          type: 'delete_block',
          path: op.path,
          index: op.args[0],
          length: op.args[1],
          duration: 300,
        };
      }

      case 'format': {
        const [offset, length, attributes] = op.args;
        return {
          type: 'format',
          path: op.path,
          offset,
          length,
          attributes,
          duration: 300,
        };
      }

      case 'setAttribute': {
        return {
          type: 'set_attribute',
          path: op.path,
          attribute: op.args[0],
          value: op.args[1],
          duration: 200,
        };
      }

      default:
        // Other operations don't have cursor animations yet
        return null;
    }
  }

  /**
   * Resets the tracker, clearing all recorded operations
   */
  reset() {
    this.operations = [];
  }

  /**
   * Gets detailed information about all operations
   * @returns {Array<object>}
   */
  getOperations() {
    return this.operations;
  }
}

module.exports = { OperationTracker };
