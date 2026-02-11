const { Pool } = require('pg');
const Y = require('yjs');

/**
 * PostgreSQL persistence adapter for Yjs
 * Implements the same interface as LeveldbPersistence
 */
class PostgresPersistence {
  /**
   * @param {string|object} connectionStringOrConfig - PostgreSQL connection string or config object
   * @param {object} opts - Additional options
   */
  constructor(connectionStringOrConfig, opts = {}) {
    this.pool = new Pool(
      typeof connectionStringOrConfig === 'string'
        ? { connectionString: connectionStringOrConfig }
        : connectionStringOrConfig
    );
    
    this.initialized = false;
    this.initPromise = null;
  }

  /**
   * Verify database schema exists
   * Note: Schema should be created via migrations (run `npm run migrate` first)
   * @private
   */
  async _init() {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const client = await this.pool.connect();
      try {
        // Verify tables exist (they should be created via migrations)
        const result = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = 'yjs_updates'
          );
        `);

        if (!result.rows[0].exists) {
          throw new Error(
            'Database schema not found. Please run migrations first: npm run migrate'
          );
        }

        this.initialized = true;
      } finally {
        client.release();
      }
    })();

    return this.initPromise;
  }

  /**
   * Get the current update clock for a document using an existing client connection
   * @private
   * @param {import('pg').PoolClient} client - Database client to use
   * @param {string} docGuid - Document GUID
   * @returns {Promise<number>} Current max clock, or -1 if no updates exist
   */
  async _getCurrentUpdateClock(client, docGuid) {
    const result = await client.query(
      'SELECT MAX(clock) as max_clock FROM yjs_updates WHERE doc_guid = $1',
      [docGuid]
    );
    return result.rows[0]?.max_clock ?? -1;
  }

  /**
   * Store a Yjs document update
   * @param {string} docGuid - Document GUID
   * @param {Uint8Array} update - Yjs update binary data
   * @param {string|null} userId - User ID who made this update (for version history)
   * @param {string|null} agentName - Agent name if update was made by an AI agent
   * @returns {Promise<number>} The clock value of the stored update
   */
  async storeUpdate(docGuid, update, userId = null, agentName = null) {
    await this._init();

    const MAX_RETRIES = 5;
    const client = await this.pool.connect();
    try {
      let nextClock;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const clock = await this._getCurrentUpdateClock(client, docGuid);
        nextClock = clock + 1;

        // If this is the first update, create a state vector entry
        if (clock === -1) {
          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, update);
          const stateVector = Y.encodeStateVector(ydoc);

          await client.query(
            'INSERT INTO yjs_state_vectors (doc_guid, state_vector, clock) VALUES ($1, $2, $3) ON CONFLICT (doc_guid) DO UPDATE SET state_vector = $2, clock = $3, updated_at = CURRENT_TIMESTAMP',
            [docGuid, Buffer.from(stateVector), nextClock]
          );
        }

        // Store the update with user_id and agent_name for version history tracking.
        // ON CONFLICT DO NOTHING means rowCount === 0 if another writer claimed this clock.
        const result = await client.query(
          'INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, agent_name) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (doc_guid, clock) DO NOTHING',
          [docGuid, nextClock, Buffer.from(update), userId, agentName]
        );

        if (result.rowCount > 0) {
          // INSERT succeeded — we claimed this clock value
          break;
        }

        // Conflict: another concurrent writer took this clock. Retry with refreshed MAX(clock).
        if (attempt === MAX_RETRIES - 1) {
          throw new Error(`storeUpdate: failed to acquire a unique clock for ${docGuid} after ${MAX_RETRIES} attempts`);
        }
      }

      // Update document timestamp (unified behavior for both regular user updates and MCP tool updates)
      // This ensures the "last opened" date is always updated when a document is edited
      // Note: If document doesn't exist in documents table, this will affect 0 rows (no error)
      await client.query(
        'UPDATE documents SET updated_at = now() WHERE id = $1',
        [docGuid]
      ).catch(err => {
        // Log but don't fail the update if document record doesn't exist
        // This can happen in edge cases where Yjs updates exist but document record doesn't
        console.warn(`Could not update documents.updated_at for ${docGuid}:`, err.message);
      });

      return nextClock;
    } finally {
      client.release();
    }
  }

  /**
   * Build a Y.Doc from update rows
   * @private
   * @param {Array} rows - Database rows with update_data column
   * @param {Object} options - Options
   * @param {boolean} [options.gc=true] - Enable garbage collection
   * @returns {Y.Doc} The reconstructed document
   */
  _buildYDocFromRows(rows, options = {}) {
    const { gc = true } = options;
    const ydoc = new Y.Doc({ gc });
    ydoc.transact(() => {
      for (const row of rows) {
        Y.applyUpdate(ydoc, new Uint8Array(row.update_data));
      }
    });
    return ydoc;
  }

  /**
   * Get all updates for a document and reconstruct the Y.Doc
   * @param {string} docGuid - Document GUID
   * @returns {Promise<Y.Doc>} The reconstructed Yjs document
   */
  async getYDoc(docGuid) {
    await this._init();

    const client = await this.pool.connect();
    try {
      const queryStart = Date.now();
      const result = await client.query(
        'SELECT update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC',
        [docGuid]
      );
      const queryTime = Date.now() - queryStart;

      const applyStart = Date.now();
      const ydoc = this._buildYDocFromRows(result.rows);
      const applyTime = Date.now() - applyStart;

      if (result.rows.length > 0) {
        const totalBytes = result.rows.reduce((sum, r) => sum + r.update_data.length, 0);
        console.log(`[Postgres] getYDoc ${docGuid}: ${result.rows.length} updates, ${totalBytes} bytes, query=${queryTime}ms, apply=${applyTime}ms`);
      }

      return ydoc;
    } finally {
      client.release();
    }
  }

  /**
   * Get the diff (updates) needed to sync a document from a given state vector
   * @param {string} docGuid - Document GUID
   * @param {Uint8Array} stateVector - State vector to diff against
   * @returns {Promise<Uint8Array>} The encoded update containing the diff
   */
  async getDiff(docGuid, stateVector) {
    const ydoc = await this.getYDoc(docGuid);
    return Y.encodeStateAsUpdate(ydoc, stateVector);
  }

  /**
   * Clear all data for a specific document
   * @param {string} docGuid - Document GUID
   * @returns {Promise<void>}
   */
  async clearDocument(docGuid) {
    await this._init();
    
    const client = await this.pool.connect();
    try {
      await client.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
      await client.query('DELETE FROM yjs_state_vectors WHERE doc_guid = $1', [docGuid]);
    } finally {
      client.release();
    }
  }

  /**
   * Clear all data from the database
   * @returns {Promise<void>}
   */
  async clearAll() {
    await this._init();
    
    const client = await this.pool.connect();
    try {
      await client.query('DELETE FROM yjs_updates');
      await client.query('DELETE FROM yjs_state_vectors');
    } finally {
      client.release();
    }
  }

  /**
   * Get a list of all document GUIDs in the database
   * @returns {Promise<Array<{docGuid: string, updatedAt: Date}>>}
   */
  async getAllDocuments() {
    await this._init();
    
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT DISTINCT doc_guid, MAX(created_at) as updated_at
        FROM yjs_updates
        GROUP BY doc_guid
        ORDER BY updated_at DESC
      `);
      
      return result.rows.map(row => ({
        docGuid: row.doc_guid,
        updatedAt: row.updated_at
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Get document metadata (title) by extracting it from the Yjs document
   * @param {string} docGuid - Document GUID
   * @returns {Promise<{title: string|null}>}
   */
  async getDocumentMeta(docGuid) {
    try {
      const ydoc = await this.getYDoc(docGuid);
      const meta = ydoc.getMap('meta');
      const title = meta.get('title') || null;
      return { title };
    } catch (error) {
      return { title: null };
    }
  }

  /**
   * Update the denormalized title in the documents table
   * This keeps the title in sync for fast list queries
   * @param {string} docGuid - Document GUID
   * @param {string|null} title - New title value
   * @returns {Promise<void>}
   */
  async updateDocumentTitle(docGuid, title) {
    await this._init();
    const client = await this.pool.connect();
    try {
      await client.query(
        'UPDATE documents SET title = $1 WHERE id = $2',
        [title, docGuid]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Get all documents with their metadata (title, updatedAt)
   * @returns {Promise<Array<{docGuid: string, title: string|null, updatedAt: Date}>>}
   */
  async getAllDocumentsWithMeta() {
    const docs = await this.getAllDocuments();
    
    // Fetch metadata for each document in parallel
    const docsWithMeta = await Promise.all(
      docs.map(async (doc) => {
        const meta = await this.getDocumentMeta(doc.docGuid);
        return {
          docGuid: doc.docGuid,
          title: meta.title,
          updatedAt: doc.updatedAt
        };
      })
    );
    
    return docsWithMeta;
  }

  // ==================== Version History Methods ====================

  /**
   * Transform a database row to an update object
   * @private
   */
  _mapUpdateRow(row, includeData = false) {
    const result = {
      clock: row.clock,
      createdAt: row.created_at,
      userId: row.user_id,
      userName: row.user_name,
      userEmail: row.user_email,
      userPicture: row.user_picture,
      agentName: row.agent_name,
    };
    if (includeData && row.update_data) {
      result.updateData = new Uint8Array(row.update_data);
    }
    return result;
  }

  /**
   * Query updates with user info (consolidated query method)
   * @private
   * @param {string} docGuid - Document GUID
   * @param {Object} options - Query options
   * @param {number} [options.clockStart] - Starting clock value (inclusive)
   * @param {number} [options.clockEnd] - Ending clock value (inclusive)
   * @param {number} [options.limit] - Maximum number of updates to return
   * @param {boolean} [options.includeData] - Include update_data in results
   * @param {boolean} [options.recentFirst] - Query DESC and reverse (for efficient "last N" queries)
   * @returns {Promise<Array>} Updates with user metadata in ascending clock order
   */
  async _queryUpdatesWithUsers(docGuid, options = {}) {
    const { clockStart, clockEnd, limit, includeData = false, recentFirst = false } = options;

    await this._init();
    const client = await this.pool.connect();
    try {
      const dataColumn = includeData ? 'u.update_data, ' : '';
      let whereClause = 'WHERE u.doc_guid = $1';
      const params = [docGuid];

      if (clockStart !== undefined && clockEnd !== undefined) {
        whereClause += ` AND u.clock >= $${params.length + 1} AND u.clock <= $${params.length + 2}`;
        params.push(clockStart, clockEnd);
      }

      let orderClause = 'ORDER BY u.clock ASC';
      let limitClause = '';

      if (recentFirst && limit) {
        // Query DESC with limit, then reverse for ascending order
        orderClause = 'ORDER BY u.clock DESC';
        limitClause = `LIMIT $${params.length + 1}`;
        params.push(limit);
      }

      const result = await client.query(
        `SELECT u.clock, ${dataColumn}u.created_at, u.user_id, u.agent_name,
                usr.name as user_name, usr.email as user_email, usr.picture as user_picture
         FROM yjs_updates u
         LEFT JOIN users usr ON u.user_id = usr.id
         ${whereClause}
         ${orderClause}
         ${limitClause}`,
        params
      );

      const rows = recentFirst && limit ? result.rows.reverse() : result.rows;
      return rows.map(row => this._mapUpdateRow(row, includeData));
    } finally {
      client.release();
    }
  }

  /**
   * Get updates in a clock range with user info
   * @param {string} docGuid - Document GUID
   * @param {number} clockStart - Starting clock value (inclusive)
   * @param {number} clockEnd - Ending clock value (inclusive)
   * @returns {Promise<Array>} Updates with metadata
   */
  async getUpdatesInRange(docGuid, clockStart, clockEnd) {
    return this._queryUpdatesWithUsers(docGuid, { clockStart, clockEnd, includeData: true });
  }

  /**
   * Get recent updates with user info (limited query for metadata)
   * @param {string} docGuid - Document GUID
   * @param {number} limit - Maximum number of updates to return (default: 100)
   * @returns {Promise<Array>} Recent updates with user metadata in ascending clock order
   */
  async getRecentUpdatesWithUsers(docGuid, limit = 100) {
    return this._queryUpdatesWithUsers(docGuid, { limit, recentFirst: true });
  }

  /**
   * Get all updates with user info for version timeline
   * @param {string} docGuid - Document GUID
   * @returns {Promise<Array>} All updates with user metadata
   */
  async getUpdatesWithUsers(docGuid) {
    return this._queryUpdatesWithUsers(docGuid);
  }

  /**
   * Reconstruct Y.Doc at a specific clock value
   * @param {string} docGuid - Document GUID
   * @param {number} clock - Clock value to reconstruct up to
   * @returns {Promise<Y.Doc>} Document state at that clock
   */
  async getYDocAtClock(docGuid, clock) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT update_data FROM yjs_updates WHERE doc_guid = $1 AND clock <= $2 ORDER BY clock ASC',
        [docGuid, clock]
      );
      return this._buildYDocFromRows(result.rows);
    } finally {
      client.release();
    }
  }

  /**
   * Get the full Y.Doc with all history (gc disabled) for version diff comparison.
   * This returns a document with ALL updates applied and gc:false so deleted items
   * are preserved for snapshot comparison.
   * @param {string} docGuid - Document GUID
   * @returns {Promise<Y.Doc>} The full Yjs document with history
   */
  async getYDocWithHistory(docGuid) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC',
        [docGuid]
      );
      return this._buildYDocFromRows(result.rows, { gc: false });
    } finally {
      client.release();
    }
  }

  /**
   * Get state vectors at specific clock positions for snapshot creation.
   * This builds the document incrementally and captures state vectors at each target clock.
   * @param {string} docGuid - Document GUID
   * @param {number[]} clocks - Array of clock values to get state vectors for
   * @returns {Promise<Map<number, Uint8Array>>} Map of clock -> encoded state vector
   */
  async getStateVectorsAtClocks(docGuid, clocks) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT clock, update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC',
        [docGuid]
      );

      const sortedClocks = [...clocks].sort((a, b) => a - b);
      const stateVectors = new Map();
      const ydoc = new Y.Doc({ gc: false });
      let clockIndex = 0;

      for (const row of result.rows) {
        Y.applyUpdate(ydoc, new Uint8Array(row.update_data));

        // Check if we've reached any target clocks
        while (clockIndex < sortedClocks.length && row.clock >= sortedClocks[clockIndex]) {
          stateVectors.set(sortedClocks[clockIndex], Y.encodeStateVector(ydoc));
          clockIndex++;
        }
      }

      // If any clocks are beyond the last update, use the final state
      while (clockIndex < sortedClocks.length) {
        stateVectors.set(sortedClocks[clockIndex], Y.encodeStateVector(ydoc));
        clockIndex++;
      }

      ydoc.destroy();
      return stateVectors;
    } finally {
      client.release();
    }
  }

  /**
   * Get the total number of updates for a document
   * @param {string} docGuid - Document GUID
   * @returns {Promise<number>} Total update count
   */
  async getUpdateCount(docGuid) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT COUNT(*) as count FROM yjs_updates WHERE doc_guid = $1',
        [docGuid]
      );
      return parseInt(result.rows[0].count, 10);
    } finally {
      client.release();
    }
  }

  /**
   * Get named versions for a document
   * @param {string} docGuid - Document GUID
   * @returns {Promise<Array>} Named versions
   */
  async getNamedVersions(docGuid) {
    await this._init();
    const client = await this.pool.connect();
    try {
      // Join with yjs_updates to get the original timestamp of the clock_end update
      const result = await client.query(
        `SELECT v.*, u.name as creator_name, u.email as creator_email, u.picture as creator_picture,
                upd.created_at as original_timestamp
         FROM document_versions v
         LEFT JOIN users u ON v.created_by = u.id
         LEFT JOIN yjs_updates upd ON upd.doc_guid = v.doc_id AND upd.clock = v.clock_end
         WHERE v.doc_id = $1
         ORDER BY v.clock_end DESC`,
        [docGuid]
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Create a named version snapshot
   * @param {string} docGuid - Document GUID
   * @param {number} clockStart - Starting clock
   * @param {number} clockEnd - Ending clock
   * @param {string|null} name - Version name (null for auto-generated)
   * @param {string|null} userId - User who created this version
   * @returns {Promise<Object>} Created version
   */
  async createNamedVersion(docGuid, clockStart, clockEnd, name, userId) {
    await this._init();
    const client = await this.pool.connect();
    try {
      // Generate snapshot data for fast loading
      const ydoc = await this.getYDocAtClock(docGuid, clockEnd);
      const snapshotData = Y.encodeStateAsUpdate(ydoc);

      const result = await client.query(
        `INSERT INTO document_versions (doc_id, name, clock_start, clock_end, snapshot_data, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [docGuid, name, clockStart, clockEnd, Buffer.from(snapshotData), userId]
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * Update a named version
   * @param {string} versionId - Version ID
   * @param {string} name - New version name
   * @returns {Promise<Object>} Updated version
   */
  async updateVersionName(versionId, name) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'UPDATE document_versions SET name = $1 WHERE id = $2 RETURNING *',
        [name, versionId]
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * Delete a named version
   * @param {string} versionId - Version ID
   * @returns {Promise<boolean>} True if deleted
   */
  async deleteNamedVersion(versionId) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'DELETE FROM document_versions WHERE id = $1',
        [versionId]
      );
      return result.rowCount > 0;
    } finally {
      client.release();
    }
  }

  /**
   * Get a named version by ID
   * @param {string} versionId - Version ID
   * @returns {Promise<Object|null>} Version or null
   */
  async getVersionById(versionId) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT v.*, u.name as creator_name, u.email as creator_email, u.picture as creator_picture
         FROM document_versions v
         LEFT JOIN users u ON v.created_by = u.id
         WHERE v.id = $1`,
        [versionId]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  /**
   * Close the database connection pool
   * @returns {Promise<void>}
   */
  async destroy() {
    await this.pool.end();
  }

  /**
   * Get the database connection pool
   * Useful for sharing the pool with other modules (e.g., auth)
   * @returns {Pool}
   */
  getPool() {
    return this.pool;
  }
}

module.exports = { PostgresPersistence };

