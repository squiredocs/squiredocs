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
   * @returns {Promise<number>} The clock value of the stored update
   */
  async storeUpdate(docGuid, update) {
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

      // Store the update (ignore if duplicate - can happen with writeState)
      await client.query(
        'INSERT INTO yjs_updates (doc_guid, clock, update_data) VALUES ($1, $2, $3) ON CONFLICT (doc_guid, clock) DO NOTHING',
        [docGuid, nextClock, Buffer.from(update)]
      );

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
    
    const client = await this.pool.connect();
    try {
      // Get all updates ordered by clock
      const result = await client.query(
        'SELECT update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC',
        [docGuid]
      );

      const updates = result.rows.map(row => new Uint8Array(row.update_data));
      
      // Reconstruct the document by applying all updates
      const ydoc = new Y.Doc();
      ydoc.transact(() => {
        for (let i = 0; i < updates.length; i++) {
          Y.applyUpdate(ydoc, updates[i]);
        }
      });

      // If we have many updates, consider flushing to optimize storage
      // (This is similar to LevelDB's PREFERRED_TRIM_SIZE behavior)
      const PREFERRED_TRIM_SIZE = 500;
      if (updates.length > PREFERRED_TRIM_SIZE) {
        // Flush: replace all updates with a single state update
        const stateAsUpdate = Y.encodeStateAsUpdate(ydoc);
        const stateVector = Y.encodeStateVector(ydoc);
        
        // Delete old updates and state vector
        await client.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
        await client.query(
          'DELETE FROM yjs_state_vectors WHERE doc_guid = $1',
          [docGuid]
        );
        
        // Store the new state
        await client.query(
          'INSERT INTO yjs_state_vectors (doc_guid, state_vector, clock) VALUES ($1, $2, $3)',
          [docGuid, Buffer.from(stateVector), 0]
        );
        
        // Store the single state update
        await client.query(
          'INSERT INTO yjs_updates (doc_guid, clock, update_data) VALUES ($1, $2, $3)',
          [docGuid, 0, Buffer.from(stateAsUpdate)]
        );
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

