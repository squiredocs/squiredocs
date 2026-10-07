/**
 * Document export API
 *
 * GET /api/docs/:docId/export — serialize a document to Markdown as a
 * downloadable file, optionally as a zip bundle with image assets. Loads the
 * latest persisted state from Postgres (source of truth), so export works
 * even when no client is connected. View access is sufficient. Works with
 * browser sessions and sk_sqd_ API tokens alike (requireAuth accepts both;
 * scoped tokens need documents:read).
 *
 * Query options (specs/003-portable-export/contracts/export-api.md):
 *   format      markdown | md (default) | bundle
 *   flavor      portable (default on all formats; Sam overruled RD-1, 2026-07-13) | squire
 *   frontmatter true/1 | false/0 (default off for markdown, on for bundle)
 *
 * A request with no new options is byte-identical to the pre-feature
 * output (FR-022) — except documents containing task lists or hard breaks,
 * which previously exported lossily (the spec's declared bug-fix exception).
 */
const express = require('express');
const Y = require('yjs');
const archiver = require('archiver');
const { requireAuth } = require('../auth');
const rateLimit = require('../rate-limit');
const documents = require('../documents');
const documentImages = require('../document-images');
const imageStorage = require('../image-storage');
const { toMarkdown, buildFrontmatter } = require('../mcp/yjs/serialization');
const versionHistory = require('../version-history');
const { resolveForRows } = require('../resupply-resolution');
const { notifyException } = require('../exception-notifier');

// Sanitize a document title into a safe download filename (without extension).
// Strips characters invalid in a Content-Disposition filename / common filesystems,
// collapses whitespace, caps length, and falls back to "document" if empty.
function sanitizeFilename(title) {
  const cleaned = String(title || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .trim();
  return cleaned || 'document';
}

/**
 * Derive the bundle asset-directory slug from the document title (FR-019,
 * research R9): NFKD-normalize, strip diacritics, lowercase, collapse
 * non-alphanumeric runs to '-', trim, cap at 60 chars, fallback 'doc'.
 * Pure and total — never throws (spec Edge Cases).
 */
function slugifyDocTitle(title) {
  let slug;
  try {
    slug = String(title == null ? '' : title)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // combining diacritics
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '');
  } catch {
    slug = '';
  }
  return slug || 'doc';
}

// Asset file extension from the stored MIME type (ALLOWED_IMAGE_MIME_TYPES).
const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// Header values must be Latin-1; setHeader throws on e.g. em dashes.
// For non-ASCII names send an ASCII fallback plus the full Unicode name
// via RFC 5987 filename*.
function contentDisposition(filename) {
  const asciiFilename = filename.replace(/[^\x20-\x7e]/g, '_');
  return asciiFilename === filename
    ? `attachment; filename="${filename}"`
    : `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Latest clock + last-modifier identity from the yjs update log — the same
 * sources the document listing exposes (research R12); no new tracking.
 *
 * The identity goes through the SAME single-slot collapse the MCP
 * `lastModifiedBy` uses (feature 045, RBD-045-12; the export twin was added by
 * the 045 review, MEDIUM-3). It matters more here than anywhere else: this
 * field is written into a DURABLE artifact that leaves the product, so naming
 * the client that merely relayed a lost edit would record the lie permanently
 * in someone's repository. A relayed row is therefore resolved to its true
 * author, or — when authorship cannot be recovered — emitted as `''`, the same
 * value a document with no rows at all produces. "Synced content" is a UI
 * contributor entry, not an identity, and never goes into front-matter.
 *
 * A row that is not `via_sync` takes the pre-045 path unchanged, so every
 * existing export is byte-identical (FR-022).
 */
async function getExportMeta(persistence, docId) {
  const result = await persistence.pool.query(
    `SELECT yu.clock, yu.user_id, yu.agent_name, yu.via_sync, usr.email, usr.name, usr.picture
     FROM yjs_updates yu
     LEFT JOIN users usr ON yu.user_id = usr.id
     WHERE yu.doc_guid = $1
     ORDER BY yu.clock DESC
     LIMIT 1`,
    [docId]
  );
  const row = result.rows[0];
  if (!row) return { clock: 0, lastModifiedBy: '' };

  const clock = Number(row.clock);
  if (row.via_sync !== true) {
    return { clock, lastModifiedBy: row.email || row.agent_name || '' };
  }

  const relayed = {
    clock,
    userId: row.user_id,
    agentName: row.agent_name,
    userName: row.name,
    userEmail: row.email,
    userPicture: row.picture,
    viaSync: true,
  };
  const resolution = await resolveForRows(persistence, docId, [relayed]);
  const author = versionHistory.authorForSingleSlot(relayed, resolution);
  return {
    clock,
    lastModifiedBy: author && !author.isSynced ? (author.email || author.name || '') : '',
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve this document's referenced images and rewrite their references to
 * relative bundle paths (contracts/bundle-zip-layout.md, research R10).
 * Doc-scoped: only `/api/docs/<docId>/images/<imageId>` URLs for THIS docId
 * are considered; foreign-doc or non-app URLs are untouched. Per-image
 * degradation (FR-021): missing row, disabled storage, or a failed fetch
 * skips that image — the reference keeps its app URL, the export succeeds.
 *
 * @returns {Promise<{ markdown: string, images: Object<string,string>, assets: Array<{name: string, data: Buffer}> }>}
 */
async function collectBundleAssets(markdown, docId, docSlug) {
  const images = {};
  const assets = [];
  // Alt text may contain backslash-escaped brackets (serializer F4), so the
  // alt span is "any escaped char or any non-]/non-\ char" rather than a naive
  // [^\]]* that a literal `]` inside the alt would terminate early.
  const ALT = '(?:\\\\.|[^\\]\\\\])*';
  const scanRe = new RegExp(
    `!\\[${ALT}\\]\\(${escapeRegex(`/api/docs/${docId}/images/`)}([0-9a-fA-F-]{36})\\)`,
    'g'
  );
  const ids = [...new Set([...markdown.matchAll(scanRe)].map((m) => m[1]))];

  let rewritten = markdown;
  for (const imageId of ids) {
    if (!imageStorage.isEnabled()) continue;
    const row = await documentImages.getImage(imageId, docId);
    if (!row) continue;
    let data;
    try {
      data = await imageStorage.getObject(row.s3_key);
    } catch {
      continue; // per-image skip; reference keeps its app URL
    }
    const ext = EXT_BY_MIME[row.mime_type] || 'bin';
    const relPath = `./assets/${docSlug}/${imageId}.${ext}`;
    const appUrl = `/api/docs/${docId}/images/${imageId}`;
    // Rewrite image references only (not arbitrary link hrefs).
    const refRe = new RegExp(`(!\\[${ALT}\\]\\()${escapeRegex(appUrl)}(\\))`, 'g');
    rewritten = rewritten.replace(refRe, `$1${relPath}$2`);
    images[relPath] = imageId;
    assets.push({ name: `assets/${docSlug}/${imageId}.${ext}`, data });
  }
  assets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { markdown: rewritten, images, assets };
}

/**
 * Build the export router.
 * @param {object} persistence - PostgresPersistence instance
 * @returns {express.Router}
 */
function createExportRouter(persistence) {
  const router = express.Router();

  router.get('/api/docs/:docId/export', requireAuth, rateLimit.perUser('export'), async (req, res) => {
    try {
      const { docId } = req.params;
      const { format = 'markdown', flavor: flavorParam, frontmatter: frontmatterParam } = req.query;
      const userId = req.user.userId;

      // View access is sufficient (same check as history/diff)
      const role = await documents.getRole(docId, userId);
      if (!role) {
        return res.status(403).json({ error: 'You do not have access to this document' });
      }

      if (format !== 'markdown' && format !== 'md' && format !== 'bundle') {
        return res.status(400).json({
          error: `Unsupported export format: ${format}. Accepted values: markdown, md, bundle`,
        });
      }
      const isBundle = format === 'bundle';

      // flavor: squire default (RD-1); bundle defaults portable (RD-3)
      let flavor = 'portable'; // portable default on every format (Sam overruled RD-1, 2026-07-13)
      if (flavorParam !== undefined) {
        if (flavorParam !== 'squire' && flavorParam !== 'portable') {
          return res.status(400).json({
            error: `Unsupported export flavor: ${flavorParam}. Accepted values: squire, portable`,
          });
        }
        flavor = flavorParam;
      }

      // frontmatter: off by default for markdown; on for bundle (RD-3)
      let withFrontmatter = isBundle;
      if (frontmatterParam !== undefined) {
        if (frontmatterParam === 'true' || frontmatterParam === '1') {
          withFrontmatter = true;
        } else if (frontmatterParam === 'false' || frontmatterParam === '0') {
          withFrontmatter = false;
        } else {
          return res.status(400).json({
            error: `Unsupported frontmatter value: ${frontmatterParam}. Accepted values: true, false, 1, 0`,
          });
        }
      }

      // Capture the export clock FIRST, then reconstruct the body at exactly
      // that clock (the same atomicity contract reExport uses via
      // getYDocAtClock). Reading the body and MAX(clock) as two independent
      // "latest" reads let an interleaved edit land between them, so the
      // frontmatter could claim a clock/state the serialized body did not have —
      // and the next sync push, baselined on that mismatched clock, would
      // silently revert the interleaved edit. Building at meta.clock excludes
      // any later-arriving update, keeping frontmatter and body consistent.
      const meta = await getExportMeta(persistence, docId);
      const ydoc = await persistence.getYDocAtClock(docId, meta.clock);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const title = ydoc.getMap('meta').get('title') || 'Untitled';

      const lossy = new Set();
      let markdown = toMarkdown(xmlFragment, { flavor, lossy });

      let images = null;
      let assets = [];
      if (isBundle) {
        const bundle = await collectBundleAssets(markdown, docId, slugifyDocTitle(title));
        markdown = bundle.markdown;
        images = bundle.images;
        assets = bundle.assets;
      }

      if (withFrontmatter) {
        const fm = buildFrontmatter({
          docGuid: docId,
          title,
          clock: meta.clock,
          exportedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          lastModifiedBy: meta.lastModifiedBy,
          flavor,
          lossy,
          images: images || undefined,
        });
        markdown = fm + '\n' + markdown;
      }

      const filenameBase = sanitizeFilename(title);
      if (!isBundle) {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', contentDisposition(filenameBase + '.md'));
        return res.send(markdown);
      }

      // Bundle: stream a zip — markdown first, then assets sorted by name
      // (structural determinism per RD-5/SC-004; byte-identical zips are not
      // promised — entry timestamps differ).
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', contentDisposition(filenameBase + '.zip'));
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err) => {
        console.error('Error streaming export bundle:', err);
        notifyException(err, { req, source: 'api' });
        res.destroy(err);
      });
      archive.pipe(res);
      archive.append(markdown, { name: `${filenameBase}.md` });
      for (const asset of assets) {
        archive.append(asset.data, { name: asset.name });
      }
      await archive.finalize();
    } catch (error) {
      console.error('Error exporting document:', error);
      notifyException(error, { req, source: 'api' });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to export document' });
      } else {
        res.destroy(error);
      }
    }
  });

  return router;
}

module.exports = {
  createExportRouter,
  collectBundleAssets,
  sanitizeFilename,
  slugifyDocTitle,
};
