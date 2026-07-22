/**
 * import_markdown_file MCP Tool (feature 019, US1)
 *
 * The sync-shaped affordance in the tool list: takes NO document content, no
 * file contents, and no file path — it returns ONE ready-to-run compound
 * shell command that (a) claims a one-shot API token via the existing
 * pending-mint machinery, (b) curls the file's bytes over the REST byte
 * channel for the resolved intent, and (c) writes the frontmattered receipt
 * back over the source file, leaving it a valid mode=sync baseline.
 *
 * Security shape: the mint path is prepareClaimDelivery() shared with
 * create_access_token (research R1) — same no-chaining guard, same
 * delegation-liveness re-check, same one-shot 300 s claim window. The only
 * secret in the result is the one_time_use_ claim secret inside `command`
 * (existing, accepted transcript residue). No sk_sqd_ token and no document
 * content ever transit this tool in either direction (FR-002/FR-005/SC-003).
 *
 * Statelessness (FR-008): the tool never probes the target document — an
 * unknown or inaccessible docGuid still yields a recipe, and the REST call
 * fails later with the channel's existing 403 semantics.
 */
const apiTokens = require('../auth/api-tokens');
const { prepareClaimDelivery } = require('./create-access-token');

// The claim flow is wired through boot-time singletons (api-tokens,
// delegation, pending-mints); the tool holds no persistence handle of its
// own. init is kept only to satisfy the tool contract.
function init() {}

const name = 'import_markdown_file';

// RBD-6: write for the import, read so the same token covers the receipt
// write-back (export) and follow-up pulls.
const MINT_SCOPES = ['documents:read', 'documents:write'];

const description = `Sync or import an EXISTING markdown file into a document — no retyping: the file's bytes move over the REST byte channel, never through model context.

This tool takes NO content and NO file path. It returns one ready-to-run compound shell command that (1) claims a one-shot API token straight to ~/.squire/token, (2) imports your file's bytes byte-faithfully over HTTP, and (3) writes the frontmattered receipt back over the file — making it a valid mode=sync baseline for future pushes. Edit only the FILE= line, then run it once within 5 minutes.

INTENT:
- create (default without docGuid): new document from the file
- update (requires docGuid): the file replaces the document's content wholesale
- sync (default with docGuid): baseline-anchored push of the file's edits

Use this whenever the markdown already exists as bytes on disk — even if you have already read the file into context, the file remains the source of truth. No shell? The result's guidance field covers you.`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description:
        'Target document UUID. Required for intent "update"/"sync"; omit it to create a new document from the file.',
    },
    intent: {
      type: 'string',
      enum: ['create', 'update', 'sync'],
      description:
        'What to do with the file: "create" a new document (default without docGuid), "update" (file replaces the document wholesale), or "sync" (baseline-anchored push; default with docGuid).',
    },
  },
  required: [],
};

/**
 * Resolve the intent per RBD-1/FR-004: omitted intent defaults to "sync"
 * when docGuid is present, else "create"; update/sync require docGuid;
 * create forbids it. Errors are instructive parameter errors.
 */
function resolveIntent(intent, docGuid) {
  const resolved = intent === undefined ? (docGuid ? 'sync' : 'create') : intent;

  if ((resolved === 'update' || resolved === 'sync') && !docGuid) {
    throw new Error(
      `Invalid parameters for tool '${name}': intent '${resolved}' targets an EXISTING document — ` +
      `pass docGuid, or omit intent to create a new document from the file.`
    );
  }
  if (resolved === 'create' && docGuid) {
    throw new Error(
      `Invalid parameters for tool '${name}': intent 'create' makes a NEW document, but a docGuid was ` +
      `supplied — omit docGuid to create, or use intent 'update' or 'sync' to target that document.`
    );
  }
  return resolved;
}

/**
 * Build the compound shell command (research R2): one POSIX shell + curl
 * block, newline-joined, run in a single invocation. The FILE= placeholder
 * is the FIRST line and the only edit the agent makes (RBD-2). The token is
 * only ever a curl -o target or a $(cat ~/.squire/token) reference — never
 * echoed. The receipt write-back is a follow-up export GET (raw markdown on
 * the wire; JSON-safe markdown extraction is impossible in portable shell).
 */
function buildCommand({ intent, docGuid, claimSecret, claimUrl, baseUrl }) {
  const claimMinutes = 5; // pendingMints.CLAIM_TTL_SECONDS / 60 — fixed window
  const lines = [
    `FILE=path/to/your.md   # <- the ONLY edit: set your markdown file's path`,
    `set -e; umask 077; mkdir -p ~/.squire`,
    `curl -sf -H "Authorization: Bearer ${claimSecret}" \\`,
    `  "${claimUrl}" -o ~/.squire/token \\`,
    `  || { echo "claim failed: already claimed or expired (${claimMinutes} min) — call import_markdown_file again for a fresh recipe"; exit 1; }`,
    `RESP=$(mktemp)`,
  ];

  if (intent === 'create') {
    lines.push(
      `curl -sf -X POST -H "Authorization: Bearer $(cat ~/.squire/token)" \\`,
      `  -H "Content-Type: text/markdown" --data-binary @"$FILE" \\`,
      `  "${baseUrl}/api/docs/import?frontmatter=true" -o "$RESP" \\`,
      `  || { echo "import failed:"; cat "$RESP"; echo; rm -f "$RESP"; exit 1; }`,
      // Escape-safe docId extraction: UUIDs draw from [0-9a-f-], which never
      // needs JSON escaping (research R2).
      `DOC=$(grep -o '"docId":"[^"]*"' "$RESP" | head -1 | cut -d'"' -f4); rm -f "$RESP"`
    );
  } else {
    const mode = intent === 'update' ? 'replace' : 'sync';
    lines.push(
      `curl -sf -X PUT -H "Authorization: Bearer $(cat ~/.squire/token)" \\`,
      `  -H "Content-Type: text/markdown" --data-binary @"$FILE" \\`,
      `  "${baseUrl}/api/docs/${docGuid}/import?mode=${mode}&frontmatter=true" -o "$RESP" \\`,
      `  || { echo "import failed:"; cat "$RESP"; echo; rm -f "$RESP"; exit 1; }`,
      `rm -f "$RESP"`,
      `DOC=${docGuid}`
    );
  }

  lines.push(
    `curl -sf -H "Authorization: Bearer $(cat ~/.squire/token)" \\`,
    `  "${baseUrl}/api/docs/$DOC/export?format=markdown&frontmatter=true" -o "$FILE"`,
    // The URL is part of the receipt so agents relay it instead of guessing a
    // route form (030 matrix caught a fabricated /docs/<guid>; canonical is /d/).
    `echo "Imported $FILE -> document $DOC. View it at ${baseUrl}/d/$DOC — receipt written back; the file is now a valid mode=sync baseline."`
  );

  return lines.join('\n');
}

/**
 * Handler function for the tool
 * @param {object} args - { docGuid?, intent? }
 * @param {object} agentToken - Authenticated principal (agent JWT or API token)
 * @returns {Promise<object>} { command, intent, docGuid?, claimExpiresInSeconds, message, guidance }
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(args, agentToken) {
  // SECURITY (review F3): docGuid is interpolated into the server-blessed shell
  // command (the whole point of the tool is "run this as-is"), and
  // validateToolArgs does not enforce the schema's uuid format. A non-UUID
  // value could inject shell. Validate here before any interpolation.
  if (args.docGuid !== undefined && !(typeof args.docGuid === 'string' && UUID_RE.test(args.docGuid))) {
    throw new Error(
      `Invalid parameters for tool '${name}': 'docGuid' must be a document UUID.`
    );
  }

  // SECURITY (review F2): the recipe mints [read,write]; cap it at the caller's
  // own scopes so a write-only principal (e.g. an ingest-only token) can't
  // escalate to read and export every doc. create_access_token enforces the
  // same invariant.
  const granted = agentToken.scopes || [];
  const exceeding = MINT_SCOPES.filter((s) => !granted.includes(s));
  if (exceeding.length > 0) {
    throw new Error(
      `Insufficient scope: import_markdown_file mints a token with ${MINT_SCOPES.map((s) => `'${s}'`).join(' + ')}, `
      + `but your credential grants only ${granted.length ? granted.map((s) => `'${s}'`).join(', ') : '(none)'}. `
      + `Use a credential with both documents:read and documents:write.`
    );
  }

  const intent = resolveIntent(args.intent, args.docGuid);

  const tokenName =
    `Minted by ${agentToken.agentName || agentToken.agentId || 'agent'} via import_markdown_file`.slice(0, 255);

  const { claimSecret, claimUrl, claimExpiresInSeconds } = await prepareClaimDelivery(agentToken, {
    scopes: MINT_SCOPES,
    ttlSeconds: apiTokens.MINTED_TOKEN_DEFAULT_TTL_SECONDS,
    name: tokenName,
  });

  const baseUrl = agentToken.baseUrl || 'https://squiredocs.com';
  const command = buildCommand({ intent, docGuid: args.docGuid, claimSecret, claimUrl, baseUrl });

  const result = {
    command,
    intent,
    claimExpiresInSeconds,
    message:
      `Set the FILE= line to your markdown file's path — that is the only edit needed — then run the ` +
      `command once in your shell within ${Math.round(claimExpiresInSeconds / 60)} minutes. The token claim ` +
      `inside it is one-shot (first run wins); if it expired or was already claimed, call ` +
      `import_markdown_file again for a fresh recipe. No document content or token appears in this result.`,
    guidance:
      `No shell? If you can make HTTP requests directly: mint a token with ` +
      `create_access_token({ inline: true, scopes: ["documents:read", "documents:write"] }) and follow ` +
      `get_tool_documentation({ tool: "rest_api" }) to import the file over REST yourself. If you cannot ` +
      `make HTTP requests at all, use the in-context path for small content — create_document({ markdown }) ` +
      `or modify (passing allowRetyped: true above the size-refusal threshold).`,
  };
  if (intent !== 'create') {
    result.docGuid = args.docGuid;
  }
  return result;
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
