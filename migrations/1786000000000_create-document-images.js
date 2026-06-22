/**
 * Migration: Create document_images table for document image support.
 * - Metadata only; image bytes live in S3 (see server/s3-images.js).
 * - One row per uploaded image; the document references it via an app URL
 *   (/api/docs/:docId/images/:imageId), never the bytes.
 * - ON DELETE CASCADE ties an image's lifecycle to its document.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('document_images', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    doc_id: {
      type: 'uuid',
      notNull: true,
      references: 'documents(id)',
      onDelete: 'CASCADE',
    },
    uploader_id: {
      type: 'uuid',
      references: 'users(id)',
      onDelete: 'SET NULL',
    },
    mime_type: {
      type: 'text',
      notNull: true,
    },
    filename: {
      type: 'text',
    },
    byte_size: {
      type: 'integer',
      notNull: true,
    },
    s3_key: {
      type: 'text',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('document_images', 'doc_id', {
    name: 'idx_document_images_doc_id',
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('document_images');
};
