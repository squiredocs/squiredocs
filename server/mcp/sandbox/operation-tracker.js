/**
 * Operation tracker
 * Records all Yjs operations performed during script execution
 * Used for generating operation summaries
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
   * Records an operation
   * @param {object} operation - Operation details
   * @param {string} operation.type - Operation type (insert, delete, format, etc.)
   * @param {string} operation.category - Operation category ('mutation' or 'read')
   * @param {string} operation.target - Target Yjs type (XmlFragment, XmlElement, XmlText)
   * @param {number[]} operation.path - Path in document tree
   * @param {any[]} operation.args - Operation arguments
   * @param {number} operation.timestamp - Operation timestamp
   */
  record(operation) {
    this.operations.push({
      type: operation.type,
      category: operation.category,
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
