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
   * Get the current update clock for a document
   * @private
   */
  async _getCurrentUpdateClock(docGuid) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT MAX(clock) as max_clock FROM yjs_updates WHERE doc_guid = $1',
        [docGuid]
      );
      return result.rows[0]?.max_clock ?? -1;
    } finally {
      client.release();
    }
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

    const clock = await this._getCurrentUpdateClock(docGuid);
    const nextClock = clock + 1;

    const client = await this.pool.connect();
    try {
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

      // Store the update with user_id and agent_name for version history tracking
      await client.query(
        'INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, agent_name) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (doc_guid, clock) DO NOTHING',
        [docGuid, nextClock, Buffer.from(update), userId, agentName]
      );

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
   * Get all updates for a document and reconstruct the Y.Doc
   * @param {string} docGuid - Document GUID
   * @returns {Promise<Y.Doc>} The reconstructed Yjs document
   */
  async getYDoc(docGuid) {
    await this._init();
    const startTime = Date.now();

    const client = await this.pool.connect();
    try {
      // Get all updates ordered by clock
      const queryStart = Date.now();
      const result = await client.query(
        'SELECT update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC',
        [docGuid]
      );
      const queryTime = Date.now() - queryStart;

      const updates = result.rows.map(row => new Uint8Array(row.update_data));
      const totalBytes = updates.reduce((sum, u) => sum + u.byteLength, 0);

      // Reconstruct the document by applying all updates
      const applyStart = Date.now();
      const ydoc = new Y.Doc();
      ydoc.transact(() => {
        for (let i = 0; i < updates.length; i++) {
          Y.applyUpdate(ydoc, updates[i]);
        }
      });
      const applyTime = Date.now() - applyStart;

      if (updates.length > 0) {
        console.log(`[Postgres] getYDoc ${docGuid}: ${updates.length} updates, ${totalBytes} bytes, query=${queryTime}ms, apply=${applyTime}ms`);
      }

      // Version history: We no longer compact/delete updates to preserve history
      // Instead, we create periodic snapshots for fast loading while keeping all updates
      // Snapshots are created via the version-history module when needed

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
   * Get updates in a clock range with user info
   * @param {string} docGuid - Document GUID
   * @param {number} clockStart - Starting clock value (inclusive)
   * @param {number} clockEnd - Ending clock value (inclusive)
   * @returns {Promise<Array>} Updates with metadata
   */
  async getUpdatesInRange(docGuid, clockStart, clockEnd) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT u.clock, u.update_data, u.created_at, u.user_id, u.agent_name,
                usr.name as user_name, usr.email as user_email, usr.picture as user_picture
         FROM yjs_updates u
         LEFT JOIN users usr ON u.user_id = usr.id
         WHERE u.doc_guid = $1 AND u.clock >= $2 AND u.clock <= $3
         ORDER BY u.clock ASC`,
        [docGuid, clockStart, clockEnd]
      );
      return result.rows.map(row => ({
        clock: row.clock,
        updateData: new Uint8Array(row.update_data),
        createdAt: row.created_at,
        userId: row.user_id,
        userName: row.user_name,
        userEmail: row.user_email,
        userPicture: row.user_picture,
        agentName: row.agent_name,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Get all updates with user info for version timeline
   * @param {string} docGuid - Document GUID
   * @returns {Promise<Array>} All updates with user metadata
   */
  async getUpdatesWithUsers(docGuid) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT u.clock, u.created_at, u.user_id, u.agent_name,
                usr.name as user_name, usr.email as user_email, usr.picture as user_picture
         FROM yjs_updates u
         LEFT JOIN users usr ON u.user_id = usr.id
         WHERE u.doc_guid = $1
         ORDER BY u.clock ASC`,
        [docGuid]
      );
      return result.rows.map(row => ({
        clock: row.clock,
        createdAt: row.created_at,
        userId: row.user_id,
        userName: row.user_name,
        userEmail: row.user_email,
        userPicture: row.user_picture,
        agentName: row.agent_name,
      }));
    } finally {
      client.release();
    }
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

      const ydoc = new Y.Doc();
      ydoc.transact(() => {
        for (const row of result.rows) {
          Y.applyUpdate(ydoc, new Uint8Array(row.update_data));
        }
      });

      return ydoc;
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
      const result = await client.query(
        `SELECT v.*, u.name as creator_name, u.email as creator_email, u.picture as creator_picture
         FROM document_versions v
         LEFT JOIN users u ON v.created_by = u.id
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

