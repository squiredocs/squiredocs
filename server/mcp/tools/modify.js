/**
 * modify MCP Tool
 *
 * Modify a document using a TypeScript script.
 * Scripts run in a sandboxed environment with access to Yjs API.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { executeScript } = require('../sandbox');
const { toMarkdown, loadYDoc } = require('../yjs/serialization');
const documents = require('../../documents');
const { computeChatDiff } = require('../diff-utils');
const { queryAndSerialize } = require('./read-helpers');
const { validateMermaidBlocks, validateSvgBlocks } = require('../diagram-validate');
const {
  sanitizeImageSrcs,
  reconcileCrossDocImages,
  rehostImportOriginImages,
  sanitizeLinkHrefs,
} = require('../image-validate');
const { captureEditUpdates, awaitDurableRange } = require('../yjs/edit-range');
const editRecords = require('../../undo/edit-records');
const { MODIFY_DOCUMENTATION } = require('./tool-documentation/modify');

// Upper bound on the echoed post-edit content (serialized chars). A modify
// always succeeds in changing the live document; the content echo is a
// convenience so the agent does not have to re-read. If the document is large,
// we omit the echo rather than risk tripping the chat layer's result-size cap
// (which would turn a successful edit into a misleading "too large" error).
const MAX_ECHO_CONTENT_CHARS = 60_000;

// Limits for read-only source documents (sourceDocGuids). The count cap keeps
// per-call DB loads bounded; the byte cap (summed encoded Y updates) keeps the
// sandbox isolate well under its 128MB limit — Y.Doc reconstruction expands
// snapshot bytes several-fold.
const MAX_SOURCE_DOCS = 10;
const MAX_TOTAL_SOURCE_BYTES = 8 * 1024 * 1024;

// Bounded durability wait for the edit identifier (feature 016, RBD-8):
// modify polls the log until the identity's stored rows cover every captured
// payload, then returns editRange. On timeout it returns editRangePending and
// finishes the recording in the background (bounded too, just longer).
const EDIT_RANGE_WAIT_MS = 5000;
const EDIT_RANGE_POLL_MS = 150;
const EDIT_RANGE_BACKGROUND_WAIT_MS = 60000;

// Persistence provider - set by init function
let persistenceProvider = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
}

/**
 * Tool definition for MCP discovery
 */
const name = 'modify';

// MCP clients such as Claude Code truncate tool descriptions at 2KB, so the
// MCP-facing description is a short summary pointing to get_tool_documentation.
// The in-app chat agent receives the full reference via chatDescription.
const description = `Modify the document using a TypeScript script.

REQUIRED READING: This is a summary. The full scripting API reference
(helpers, XPath targeting, Yjs API, examples, pitfalls) is too large for MCP
tool descriptions — call get_tool_documentation({ tool: "modify" }) BEFORE
writing your first script.

Replacing content from an EXISTING markdown file? Don't retype it in a
script — PUT /api/docs/:docId/import is byte-faithful; see
get_tool_documentation({ tool: "rest_api" }).

SCRIPT CONTRACT: the script must export a default function that receives the
document root:
  export default function edit(doc: Y.XmlFragment) { ... }
It runs sandboxed with the Yjs API plus built-in helpers (appendBlocks,
createFormattedText, xpath, findByText, ...). All changes are atomic (entire
script = one undo step) and sync to viewers in real time; on error everything
rolls back.

NON-NEGOTIABLE RULES:
- Target elements with XPath, e.g. xpath('//heading[@level=2]') — NEVER
  positional indexing (doc.get(n)); positions shift in collaborative docs.
- Prefer helpers: appendBlocks() to add blocks, createFormattedText() for
  mixed formatting, extractText() to read text (not toString()).
- Build documents incrementally across MULTIPLE small modify calls (one
  section per call). Never delete everything and recreate — it breaks
  collaboration and undo history; transform existing blocks in place.
- Unsure of the document structure? read_document with format:"structured"
  first.

PARAMETERS:
- docGuid: Document UUID (required)
- script: TypeScript source code (required)
- timeout: ms, default 5000, max 30000
- sourceDocGuids: Up to 10 other doc UUIDs exposed read-only as \`sources\`;
  copy across docs with cloneBlocks()
- echoContent: true to echo the full updated document (default false)

RETURNS: changed, diff (verify your edit with it), clock, editRange (undo
handle), operationCount, summary; content only with echoContent: true.
conflict + editedBy on concurrent edits (re-read, merge, retry). Script
errors include line numbers and hints.`;

const chatDescription = MODIFY_DOCUMENTATION;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'Document UUID',
    },
    script: {
      type: 'string',
      description: 'TypeScript source code to execute',
    },
    timeout: {
      type: 'integer',
      minimum: 100,
      maximum: 30000,
      default: 5000,
      description: 'Execution timeout in milliseconds',
    },
    sourceDocGuids: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      maxItems: 10,
      description: 'Optional. Up to 10 additional document UUIDs exposed READ-ONLY '
        + 'inside the script as the `sources` global (keyed by guid; iteration order '
        + 'matches array order). Use with cloneBlocks() to copy or merge content from '
        + 'other documents (e.g. concatenate docs) without re-typing it. Viewer access '
        + 'suffices. Must not include docGuid.',
    },
    echoContent: {
      type: 'boolean',
      default: false,
      description: 'Echo the full updated document content in the result. Default '
        + 'false: the result contains diff, summary, and clock but not content — '
        + 'use read_document if you need the full document. Even when true, content '
        + 'over 60,000 characters is omitted.',
    },
  },
  required: ['docGuid', 'script'],
};

/**
 * Validates script for common errors before execution
 * @param {string} script - TypeScript script to validate
 * @throws {Error} - If validation fails
 */
function validateScript(script) {
  const errors = [];

  // Check for empty script
  if (!script || script.trim().length === 0) {
    errors.push('Script cannot be empty');
  }

  // Check for export default
  if (!script.includes('export default')) {
    errors.push(
      'Script must include "export default function edit(doc) { ... }".\n' +
      '  Hint: Scripts must export a default function that receives the document as a parameter.'
    );
  }

  // Warn about dangerous patterns (but don't block)
  const warnings = [];

  if (script.includes('while (true)') || script.includes('while(true)')) {
    warnings.push('Detected "while(true)" - this will cause a timeout unless there\'s a break condition');
  }

  if (script.includes('require(')) {
    warnings.push('Detected "require()" - Node.js modules are not available in the sandbox');
  }

  if (script.includes('import ') && script.includes('from ')) {
    warnings.push('Detected "import from" - external modules are not available in the sandbox');
  }

  if (script.includes('process.') || script.includes('__dirname') || script.includes('__filename')) {
    warnings.push('Detected Node.js globals - these are not available in the sandbox');
  }

  if (errors.length > 0) {
    throw new Error(
      `Script validation failed:\n` +
      errors.map(e => `  - ${e}`).join('\n')
    );
  }

  return warnings;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates and normalizes the sourceDocGuids argument
 * @param {any} sourceDocGuids - Raw argument value
 * @param {string} docGuid - The writable target document guid
 * @returns {string[]} - Deduped guids in first-occurrence order
 * @throws {Error} - If validation fails
 */
function validateSourceDocGuids(sourceDocGuids, docGuid) {
  if (sourceDocGuids === undefined || sourceDocGuids === null) {
    return [];
  }
  if (!Array.isArray(sourceDocGuids)) {
    throw new Error('sourceDocGuids must be an array of document UUIDs');
  }
  if (sourceDocGuids.length > MAX_SOURCE_DOCS) {
    throw new Error(
      `sourceDocGuids supports at most ${MAX_SOURCE_DOCS} documents (got ${sourceDocGuids.length}). `
      + 'Copy content across multiple modify calls instead.'
    );
  }

  const invalid = sourceDocGuids.filter(g => typeof g !== 'string' || !UUID_REGEX.test(g));
  if (invalid.length > 0) {
    throw new Error(`sourceDocGuids contains invalid UUIDs: ${invalid.join(', ')}`);
  }

  if (sourceDocGuids.includes(docGuid)) {
    throw new Error(
      'sourceDocGuids must not include the target docGuid — the target document '
      + "is already available as the script's doc parameter."
    );
  }

  // Dedupe preserving first-occurrence order (order = e.g. concatenation order)
  return [...new Set(sourceDocGuids)];
}

/**
 * Tool handler
 * @param {object} args - Tool arguments
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>}
 */
async function handler(args, agentToken) {
  try {
    return await handlerImpl(args, agentToken);
  } catch (error) {
    if (!error.message.includes('get_tool_documentation')) {
      error.message += TRUNCATION_HINT;
    }
    throw error;
  }
}

// Appended to every handler error. Script authors working from a truncated
// tool description (see the 2KB note above) fail here first; the hint gives
// them the recovery path.
const TRUNCATION_HINT =
  '\n\nHINT: The modify tool has a large scripting API (built-in helpers, XPath '
  + 'targeting, Yjs API, examples, common pitfalls) that MCP clients truncate '
  + 'from its description. If you have not already fetched it, call '
  + 'get_tool_documentation({ tool: "modify" }) before retrying.';

async function handlerImpl(args, agentToken) {
  if (!persistenceProvider) {
    throw new Error('Tool not initialized');
  }

  const { docGuid, script, timeout = 5000 } = args;
  const echoContent = args.echoContent === true;

  // Validate script before execution
  validateScript(script);

  // Validate source doc guids (read-only docs exposed to the script)
  const sourceGuids = validateSourceDocGuids(args.sourceDocGuids, docGuid);

  // Validate timeout
  const validatedTimeout = Math.max(100, Math.min(30000, timeout));

  // Get or create session (establishes WebSocket presence)
  // Use 5 minute timeout to ensure cursor persists across multiple modify calls
  const session = await agentPresence.getOrCreateSession(
    docGuid,
    agentToken,
    300, // 5 minute session duration
    { requiredRole: 'editor' }
  );

  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Concurrent-edit guard. The chat layer injects _baseClock (the highest clock
  // the agent has observed for this doc); when another author has edited since
  // then, refuse and return the current content so the agent reconciles.
  // External callers omit _baseClock, so the guard is a no-op for them.
  const baseClock = typeof args._baseClock === 'number' ? args._baseClock : null;
  let recentUpdates = [];
  try {
    recentUpdates = await persistenceProvider.getRecentUpdatesWithUsers(docGuid, 100);
  } catch (e) {
    console.warn('[modify] could not load recent updates for staleness check:', e.message);
  }
  const currentClock = recentUpdates.length
    ? recentUpdates[recentUpdates.length - 1].clock
    : null;

  if (baseClock !== null) {
    const foreign = recentUpdates.filter(u =>
      typeof u.clock === 'number'
      && u.clock > baseClock
      && !(u.agentName === agentToken.agentName && u.userId === agentToken.userId)
    );
    if (foreign.length > 0) {
      // `yjs_updates` rows include non-content writes — `meta` map (title sync),
      // schema normalization by prosemirror on first render, IndexedDB replays
      // on reconnect — all attributed to whichever WebSocket connection applied
      // them. Only refuse the edit if the user-visible content (the `'default'`
      // XmlFragment) actually differs from what the agent expects: i.e. the doc
      // at baseClock replayed with the agent's own subsequent updates. Anything
      // else in the gap is a foreign edit; if those did not change the content
      // tree, the agent's modify is safe.
      let contentDiverged = true;
      try {
        const expectedDoc = await persistenceProvider.getYDocAtClock(docGuid, baseClock);
        // Postgres `clock` is int4 → max 2147483647; safe upper bound for "all rows after baseClock".
        const updatesSince = await persistenceProvider.getUpdatesInRange(
          docGuid, baseClock + 1, 2147483647
        );
        for (const u of updatesSince) {
          const isSelf = u.agentName === agentToken.agentName && u.userId === agentToken.userId;
          if (isSelf && u.updateData) {
            Y.applyUpdate(expectedDoc, u.updateData);
          }
        }
        const expectedMd = toMarkdown(expectedDoc.get('default', Y.XmlFragment));
        const currentMd = toMarkdown(xmlFragment);
        contentDiverged = expectedMd !== currentMd;
      } catch (e) {
        console.warn('[modify] could not gate conflict on content equality; treating as conflict:', e.message);
      }

      if (contentDiverged) {
        const editedBy = [...new Set(
          foreign.map(u => u.userName || u.agentName || 'another collaborator')
        )];
        const conflict = {
          changed: false,
          conflict: true,
          editedBy,
          clock: currentClock,
          message: `This document was edited by ${editedBy.join(', ')} since you last read it. `
            + 'Your change was NOT applied, to avoid overwriting their edits. '
            + (echoContent
              ? 'The current document content is included below. Read it, fold in their changes, '
                + 'then retry your modify.'
              : 'Re-read the document with read_document, fold in their changes, then retry your modify.'),
        };
        if (echoContent) {
          try {
            const serialized = queryAndSerialize(xmlFragment, undefined, 'structured');
            if (JSON.stringify(serialized.content).length <= MAX_ECHO_CONTENT_CHARS) {
              conflict.content = serialized.content;
              conflict.blockCount = serialized.blockCount;
              conflict.characterCount = serialized.characterCount;
            } else {
              conflict.contentOmitted = true;
            }
          } catch (e) {
            console.error('[modify] conflict content serialization failed:', e.message);
          }
        } else {
          conflict.contentOmitted = true;
        }
        return conflict;
      }
    }
  }

  // Load read-only source documents. Runs after the target session (target
  // access errors take precedence) and after the conflict guard (no wasted
  // loads on conflict). Sources are DB snapshots — no presence session, no
  // conflict semantics; viewer access suffices.
  let sources = [];
  if (sourceGuids.length > 0) {
    const accessible = await Promise.all(
      sourceGuids.map(guid => documents.hasAccess(guid, agentToken.userId))
    );
    const denied = sourceGuids.filter((guid, i) => !accessible[i]);
    if (denied.length > 0) {
      throw new Error(`Source documents not found or not accessible: ${denied.join(', ')}`);
    }

    const pool = persistenceProvider.getPool();
    sources = await Promise.all(sourceGuids.map(async (guid) => {
      const srcDoc = await loadYDoc(pool, guid);
      const snapshot = Buffer.from(Y.encodeStateAsUpdate(srcDoc));
      srcDoc.destroy();
      return { docGuid: guid, snapshot };
    }));

    const totalBytes = sources.reduce((sum, s) => sum + s.snapshot.byteLength, 0);
    if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
      throw new Error(
        `Source documents too large to load into the sandbox: ${totalBytes} bytes total `
        + `(limit ${MAX_TOTAL_SOURCE_BYTES}). Sizes: `
        + sources.map(s => `${s.docGuid}=${s.snapshot.byteLength}`).join(', ')
        + '. Drop some sources or copy content across multiple modify calls.'
      );
    }
  }

  // Capture state before script execution for change detection and diff
  const blockCountBefore = xmlFragment.toArray().length;
  const mdBefore = toMarkdown(xmlFragment);
  console.log(`[modify:DIAGNOSTIC] docGuid=${docGuid}`);
  console.log(`[modify:DIAGNOSTIC] sessionId=${session.sessionId}`);
  console.log(`[modify:DIAGNOSTIC] blockCountBefore=${blockCountBefore}`);

  // Capture this call's own update payloads — script transactions AND the
  // post-script sanitization passes below — for the durable edit identifier
  // (feature 016, FR-001, research R2). Remote updates arriving through the
  // session's provider mid-call are excluded: they are other authors' edits.
  const editCapture = captureEditUpdates(ydoc, { excludeOrigins: [session.provider] });

  try {
    // Execute the script
    const result = await executeScript(script, session, xmlFragment, {
      timeout: validatedTimeout,
      sources,
    });

    // Import-origin rehost (feature 002, FR-021): image nodes that entered via
    // fromMarkdown carry a transient marker on their external src. Fetch-and-
    // rehost those (or degrade to a plain link) BEFORE the strip guardrail, so
    // import-origin externals become app URLs instead of being stripped.
    // Directly authored external srcs (no marker) fall through to the strip.
    let imagesRehosted = [];
    let imagesDegraded = [];
    try {
      const rehostReport = await rehostImportOriginImages(
        xmlFragment,
        docGuid,
        agentToken.userId
      );
      imagesRehosted = rehostReport.rehosted;
      imagesDegraded = rehostReport.degraded;
    } catch (e) {
      console.error('[modify] import-origin image rehost failed:', e.message);
    }

    // Guardrail: strip any image whose src isn't an app image URL (agents may
    // reference existing images but not inject external/data srcs). Runs before
    // diff/content so the response reflects the sanitized document. Mutates the
    // live fragment, so the removal persists with the rest of the edit.
    let imageErrors = [];
    try {
      imageErrors = sanitizeImageSrcs(xmlFragment);
    } catch (e) {
      console.error('[modify] image src validation failed:', e.message);
    }

    // Images cloned/referenced from OTHER documents keep the source doc's URL,
    // which target-doc viewers may not be allowed to load. Copy accessible
    // ones into this doc (rewriting src in place); strip inaccessible ones.
    // Best-effort: on failure the cross-doc srcs simply remain (status quo).
    let imagesCopied = [];
    try {
      const reconciled = await reconcileCrossDocImages(xmlFragment, docGuid, agentToken.userId);
      imagesCopied = reconciled.copied;
      for (const r of reconciled.removed) {
        imageErrors.push({ src: r.src, reason: 'source document not accessible' });
      }
    } catch (e) {
      console.error('[modify] cross-doc image reconciliation failed:', e.message);
    }

    // Link-protocol guardrail (D-6): the same allowlist import enforces, applied
    // to this write boundary. A script may format text with a javascript:/data:/
    // vbscript: href; strip such link marks (keeping the text) so a dangerous
    // href is never stored in the CRDT — not left to the client's render-time
    // gate. Mutates the live fragment, so the fix persists with the rest of the
    // edit; reported like imageErrors so the agent learns the allowed protocols.
    let linkErrors = [];
    try {
      linkErrors = sanitizeLinkHrefs(xmlFragment);
    } catch (e) {
      console.error('[modify] link href validation failed:', e.message);
    }

    // The edit is complete (script + every sanitization pass) — close the
    // identifier capture window. Everything after this point is read-only.
    const editPayloads = editCapture.stop();

    // Capture state after script execution for change detection and diff
    const blockCountAfter = xmlFragment.toArray().length;
    const mdAfter = toMarkdown(xmlFragment);
    const changed = mdBefore !== mdAfter;
    console.log(`[modify:DIAGNOSTIC] blockCountAfter=${blockCountAfter}`);
    console.log(`[modify:DIAGNOSTIC] blocksAdded=${blockCountAfter - blockCountBefore}`);
    console.log(`[modify:DIAGNOSTIC] changed=${changed}`);

    if (result.success) {
      // Compute text diff for chat UI (best-effort)
      let diff = null;
      // Echo the updated document so the agent's view stays current without a
      // re-read. Only when the content actually changed; the chat layer's
      // dedup keeps just the most recent full-doc snapshot in context.
      let content = null;
      let characterCount;
      let updatedBlockCount = blockCountAfter;
      let mermaidErrors = [];
      let svgErrors = [];
      if (changed) {
        try {
          diff = computeChatDiff(mdBefore, mdAfter);
        } catch (e) {
          console.error('[modify] diff computation failed:', e.message);
        }
        if (echoContent) {
          try {
            const serialized = queryAndSerialize(xmlFragment, undefined, 'structured');
            content = serialized.content;
            characterCount = serialized.characterCount;
            updatedBlockCount = serialized.blockCount;
          } catch (e) {
            console.error('[modify] content serialization failed:', e.message);
          }
        }
        // Diagram blocks only render in the browser, so a Mermaid syntax error
        // or SVG content the editor's sanitizer strips would otherwise be
        // invisible to the agent. Validate server-side and surface any errors
        // so the agent can fix them. Non-blocking: the edit stands.
        try {
          mermaidErrors = await validateMermaidBlocks(xmlFragment);
        } catch (e) {
          console.error('[modify] mermaid validation failed:', e.message);
        }
        try {
          svgErrors = await validateSvgBlocks(xmlFragment);
        } catch (e) {
          console.error('[modify] svg validation failed:', e.message);
        }
      }

      const response = {
        changed,
        operationCount: result.operationCount,
        summary: result.summary,
        // RBD-1: `clock` KEEPS its pre-edit-baseline meaning — the chat
        // staleness/conflict machinery reads it. The edit identifier is the
        // separate, explicit editRange below.
        diff,
        clock: currentClock,
      };

      // Durable edit identifier (feature 016, FR-001..004): wait (bounded)
      // until the log's identity-attributed rows provably cover every payload
      // this call produced, then return the range and record the agent_edits
      // row. On timeout, return editRangePending and finish in the background
      // (RBD-8) — an undo arriving before the record exists finds nothing and
      // reports honestly (RBD-7(b)).
      if (changed) {
        const editIdentity = { userId: agentToken.userId, agentName: agentToken.agentName };
        const baseline = typeof currentClock === 'number' ? currentClock : -1;
        let editRange = null;
        try {
          editRange = await awaitDurableRange(
            persistenceProvider, docGuid, editIdentity, baseline, editPayloads,
            { timeoutMs: EDIT_RANGE_WAIT_MS, pollIntervalMs: EDIT_RANGE_POLL_MS }
          );
        } catch (e) {
          console.error('[modify] edit-range durability wait failed:', e.message);
        }
        if (editRange) {
          response.editRange = editRange;
          try {
            await editRecords.recordEdit(persistenceProvider, {
              docGuid,
              userId: editIdentity.userId,
              agentName: editIdentity.agentName,
              clockStart: editRange.clockStart,
              clockEnd: editRange.clockEnd,
            });
          } catch (e) {
            console.error('[modify] agent_edits record insert failed:', e.message);
          }
        } else {
          response.editRangePending = true;
          // Background completion: keep polling (longer bound), then record.
          awaitDurableRange(
            persistenceProvider, docGuid, editIdentity, baseline, editPayloads,
            { timeoutMs: EDIT_RANGE_BACKGROUND_WAIT_MS, pollIntervalMs: 500 }
          ).then((range) => {
            if (!range) return null;
            return editRecords.recordEdit(persistenceProvider, {
              docGuid,
              userId: editIdentity.userId,
              agentName: editIdentity.agentName,
              clockStart: range.clockStart,
              clockEnd: range.clockEnd,
            });
          }).catch((e) => {
            console.error('[modify] background edit-range recording failed:', e.message);
          });
        }
      }
      if (sourceGuids.length > 0) {
        response.sourceDocGuids = sourceGuids;
      }
      if (changed && !echoContent) {
        response.contentOmitted = true;
        response.message = 'Document updated. The diff shows what changed; use read_document '
          + '(or pass echoContent: true) if you need the full current content.';
      }
      if (changed && content !== null) {
        response.blockCount = updatedBlockCount;
        response.characterCount = characterCount;
        if (JSON.stringify(content).length <= MAX_ECHO_CONTENT_CHARS) {
          response.content = content;
        } else {
          response.contentOmitted = true;
          response.message = `Document updated (${characterCount} characters). `
            + 'The updated content was not echoed because the document is large. '
            + 'Use read_document with an xpath to view specific sections if you need the current content.';
        }
      }
      if (!changed) {
        response.message = 'No changes were made \u2014 your script ran but didn\'t modify the document. '
          + 'This usually means your XPath or element targeting didn\'t match. '
          + 'Re-read the document with format: "structured" to verify the structure before retrying.';
      }
      if (mermaidErrors.length > 0) {
        response.mermaidErrors = mermaidErrors;
        const n = mermaidErrors.length;
        const warning = `${n} mermaid diagram${n > 1 ? 's have' : ' has'} a syntax error `
          + 'and will not render. See mermaidErrors for the parser message(s) and please '
          + 'fix the diagram(s).';
        // Compose with any existing message (e.g. the large-doc omission note)
        // rather than clobbering it.
        response.message = response.message ? `${response.message} ${warning}` : warning;
      }
      if (svgErrors.length > 0) {
        response.svgErrors = svgErrors;
        const n = svgErrors.length;
        const warning = `${n} SVG block${n > 1 ? 's have' : ' has'} problems and may not render `
          + 'as written. See svgErrors for details. The edit was still applied — please '
          + 'fix the SVG block(s) in a follow-up modify.';
        response.message = response.message ? `${response.message} ${warning}` : warning;
      }
      if (imagesCopied.length > 0) {
        response.imagesCopied = imagesCopied;
      }
      if (imagesRehosted.length > 0) {
        response.imagesRehosted = imagesRehosted;
      }
      if (imagesDegraded.length > 0) {
        response.imagesDegraded = imagesDegraded;
        const n = imagesDegraded.length;
        const warning = `${n} import-origin image${n > 1 ? 's' : ''} could not be rehosted `
          + 'and degraded to plain links. See imagesDegraded for the reason(s).';
        response.message = response.message ? `${response.message} ${warning}` : warning;
      }
      if (imageErrors.length > 0) {
        response.imageErrors = imageErrors;
        const n = imageErrors.length;
        const warning = `${n} image${n > 1 ? 's were' : ' was'} removed because the src was not an `
          + 'app image URL (/api/docs/:docId/images/:imageId) or referenced a document the user '
          + 'cannot access. You can only reference images from this document or documents shared '
          + 'with the user; to add a new image from chat, use the insert_image tool.';
        response.message = response.message ? `${response.message} ${warning}` : warning;
      }
      if (linkErrors.length > 0) {
        response.linkErrors = linkErrors;
        const n = linkErrors.length;
        const warning = `${n} link${n > 1 ? 's' : ''} had ${n > 1 ? 'their' : 'its'} mark removed `
          + '(the text was kept) because the href protocol is not allowed. Links may only use '
          + 'http, https, mailto, or app-relative (/… or #…) hrefs — javascript:, data:, '
          + 'vbscript:, and file: are blocked. See linkErrors for the offending href(s).';
        response.message = response.message ? `${response.message} ${warning}` : warning;
      }

      return response;
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    editCapture.stop(); // idempotent; the success path already stopped it
    throw new Error(`Script execution failed: ${error.message}`);
  }
}

module.exports = {
  name,
  description,
  chatDescription,
  inputSchema,
  handler,
  init,
};
