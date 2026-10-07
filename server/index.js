// Load environment variables from .env file
require('dotenv').config();

// Initialize OpenTelemetry BEFORE any application module loads (feature 014,
// FR-001). This registers the CJS require-hook auto-instrumentation for
// http/express/pg/ioredis and installs the non-throwing console shim, so every
// subsequent require is instrumented and every console.* line becomes
// trace-correlated JSON. Inert (no crash, no export) when no Collector endpoint
// is configured — the default dev/CI/test state.
const telemetry = require('./telemetry');
telemetry.start();

// --- Environment sanity check (security) -------------------------------------
// NODE_ENV gates a family of production hardening guards spread across the code:
// the dev-only auth-bypass routes (/auth/dev-login), Secure + SameSite=strict
// auth cookies, the JWT/MCP weak-secret fail-fast, OAuth client-URL validation,
// and MCP error-verbosity. A deployment that leaves NODE_ENV UNSET silently runs
// every one of those in its INSECURE (non-production) mode — this exact
// misconfiguration once exposed unauthenticated session forgery in prod. Assert
// loudly at boot that NODE_ENV is a recognized value so it can never silently
// recur. Deliberately WARN rather than fail-fast: the base collab-app pod can be
// rendered without NODE_ENV in a dev cluster and must not crash-loop, and the
// dev-endpoint gate is separately fail-closed (positive ENABLE_DEV_ENDPOINTS
// opt-in), so a warning that names the exact risk is the correct floor here.
(function assertNodeEnv() {
  const env = process.env.NODE_ENV;
  if (env === 'production' || env === 'development' || env === 'test') return;
  console.error(
    '\n**********************************************************************\n' +
    `[SECURITY] NODE_ENV is ${env === undefined || env === '' ? 'UNSET' : `"${env}"`} ` +
    '— not one of production/development/test.\n' +
    'If this is a real deployment, production hardening is OFF: dev-only auth-\n' +
    'bypass routes may be mounted, auth cookies are not Secure/SameSite=strict,\n' +
    'and the JWT weak-secret fail-fast is disabled. Set NODE_ENV=production in\n' +
    'the production overlay (k8s/overlays/aws-prod).\n' +
    '**********************************************************************\n'
  );
})();

// --- Instance configuration (feature 058) -------------------------------------
// Resolved once, here, so `npm run dev` / `npm start` (which bypass the image
// entrypoint) still fail fast on an invalid APP_URL, STORAGE_DRIVER, SMTP_PORT,
// ... Every module reads the same memoized object (RBD-058-16).
const { getInstanceConfig } = require('./instance-config');
const instanceConfig = getInstanceConfig();
(function logInstanceConfig() {
  if (instanceConfig.hostedInvalidValue !== null) {
    console.warn(`[Config] SQUIRE_HOSTED="${instanceConfig.hostedInvalidValue}" is not true or false; treating as off`);
  }
  if (instanceConfig.insecureRemoteHttp) {
    console.warn(
      `[Config] APP_URL is http on a non-local host (${new URL(instanceConfig.appUrl).host}). ` +
      'Serving plain HTTP beyond localhost is not supported; put a TLS-terminating proxy in front and set an https APP_URL.'
    );
  }
  if (!instanceConfig.smtp.from) {
    console.log('[Email] off (no SMTP_FROM)');
  } else if (!instanceConfig.smtp.host) {
    console.warn('[Email] SMTP_FROM is set but SMTP_HOST is not; email is off');
  }
})();

const express = require('express');
const helmet = require('helmet');
const WebSocket = require('ws');
// `docs` is y-websocket's own doc registry (docName -> Y.Doc). Feature 041 uses
// it for two honest primitives: evicting a doc whose bind failed (FR-010) and
// asking "is this document loaded?" WITHOUT creating it (FR-013 —
// `getYDoc` is `setIfUndefined`, so the lookup IS the creation).
const { setupWSConnection, setPersistence, getYDoc, docs } = require('y-websocket/bin/utils');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { PostgresPersistence } = require('./postgres-persistence');
const redisPubSub = require('./redis-pubsub');
const { closeRedis, isRedisReady } = require('./redis');
const lifecycle = require('./lifecycle');
const rateLimit = require('./rate-limit');
const { createShutdown } = require('./shutdown');
const { createReadyHandler } = require('./ready');
const { createPendingWrites } = require('./pending-writes');
const Y = require('yjs');
const awarenessProtocol = require('y-protocols/dist/awareness.cjs');
const { router: authRouter, initUsers, requireAuth, requireAdmin } = require('./auth');
const authEvents = require('./auth/auth-events');
const admin = require('./api/admin');
const appSettings = require('./api/app-settings');
const collabGuardrail = require('./collab-guardrail');
const { parseCookies } = require('./auth/jwt');
const documents = require('./documents');
const documentImages = require('./document-images');
const imageStorage = require('./image-storage');
const permissions = require('./permissions');
const versionHistory = require('./version-history');
// The identity leaf (features 040/043). Zero-require — safe to import anywhere.
// `identityFromPrincipal` is the token-derived attribution identity every
// WebSocket connection is recorded under (043, X2).
const { identityFromPrincipal } = require('./agent-identity');
const mcp = require('./mcp');
const toolRegistry = require('./mcp/tools');
const agentPresence = require('./mcp/agent-presence');
const chat = require('./api/chat');
const chatStore = require('./chat-store');
// Feature 041 (FR-015): the verified chat "Reverted" stamp.
const chatRevertStamp = require('./api/chat-revert-stamp');
const aiUsage = require('./ai-usage');
const byokSettings = require('./api/byok-settings');
const documentService = require('./document-service');
const resupplyResolution = require('./resupply-resolution');
const undoService = require('./undo/undo-service');
const onboarding = require('./onboarding');
const search = require('./search');
const { buildCspDirectives, oldDomainRedirect, mountWebRoutes } = require('./web-routes');
const { ORIGIN_REDIS, shouldPublishToRedis } = require('./origin');
// The sync-protocol edit gate (feature 038). Frame classification AND the
// interceptor that installs it live in one module so there is exactly one
// implementation: the unit test, the FR-008 protocol e2e, and this file all
// exercise the same code. Do not reintroduce byte classification here.
const { installGate } = require('./ws-edit-gate');
// Feature 044: the awareness guard's per-document ownership view. This file
// resolves the handle and hands it over; it never parses a frame or decides an
// ownership question itself.
// `localOwnersOf` / `learnRelayedOwners` are the two halves of the
// cross-instance ownership relay (multi-replica review M4): this file only
// carries the map between the awareness publisher and the awareness receiver —
// which principal owns which clientID stays entirely the guard's judgement.
const {
  ownershipFor: awarenessOwnershipFor,
  localOwnersOf: awarenessLocalOwnersOf,
  learnRelayedOwners: awarenessLearnRelayedOwners,
} = require('./ws-awareness-guard');
// Feature 043 (X1): the y-websocket bindState and its update listener — the one
// place a live edit's user_id / agent_name / via_sync are written. It lives in
// its own module so tests can drive the real thing instead of mirroring it.
const { createBindState, extractDocGuid } = require('./collab-bind-state');
// Feature 057 (US2): cross-replica reconciliation. A pod's memory diverging
// from the durable log used to be permanent — fan-out delivery was effectively
// a correctness precondition. This is what makes it merely an optimisation.
const collabReconcile = require('./collab-reconcile');
const wsSimulator = require('./websocket-simulator');
const DiffService = require('./diff-service');
const searchIndexer = require('./search-indexer');
const support = require('./api/support');
const spacesApi = require('./api/spaces');
const spaces = require('./spaces');
const { createExportRouter } = require('./api/docs-export');
const { createImportRouter } = require('./api/docs-import');
const { createChatAttachmentsRouter } = require('./api/chat-attachments');
const { createDocumentImagesRouter } = require('./api/document-images-routes');
const { createTokenClaimRouter } = require('./api/token-claim');
const { createUndoStatusRouter } = require('./api/undo-status');
const { notifyException, setupProcessHandlers } = require('./exception-notifier');
const { sendShareInvite, sendShareNotification } = require('./email');
const { shareDocumentByEmail, changeRole, removeUserAccess } = require('./share-service');
const { buildBaseUrl } = require('./url');
const users = require('./auth/users');
setupProcessHandlers();

// Profiling utilities
const PROFILING_ENABLED = true;
let messageCounter = 0;
const logPerf = (label, data = {}) => {
  if (!PROFILING_ENABLED) return;
  const timestamp = Date.now();
  console.log(`[PERF ${timestamp}] ${label}`, JSON.stringify(data));
};

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Production-hardening env-var catalog (feature 010) ──────────────────────
// Recorded here for the converge step to fold into README.md + docs/dev.md
// (doc edits are out of this agent's scope — pipeline override). Every value is
// overridable; the defaults below are the shipped behavior.
//   TRUST_PROXY_HOPS=1              numeric trusted-proxy hop count (prod: 2)
//   SHUTDOWN_DEADLINE_MS=20000      graceful-drain force-exit backstop (< 30s grace)
//   CHAT_BODY_LIMIT=10mb            /api/chat inline JSON body cap
//   WS_MAX_PAYLOAD_BYTES=33554432   largest inbound collab WS frame (32MB; ws default is 100MiB)
//   DB_POOL_MAX=20                  pg app-pool max connections
//   DB_POOL_ACQUIRE_TIMEOUT_MS=5000 pg connection acquisition timeout
//   DB_STATEMENT_TIMEOUT_MS=30000   pg per-session server-side statement timeout
//   REDIS_PASSWORD=(unset)          Redis AUTH; unset ⇒ byte-identical behavior
//   RL_AUTH_PER_MIN=30              per-IP /auth budget
//   RL_TOKEN_PER_MIN=30            per-IP POST /mcp/auth/token budget
//   (registration is intentionally unlimited — no sign-up gate; caps removed 2026-07-18)
//   RL_SEARCH_PER_MIN=30            per-user content-search budget
//   RL_IMPORT_PER_MIN=240           per-user markdown-import budget
//   RL_EXPORT_PER_MIN=240           per-user document-export budget
//   RL_CHAT_PER_MIN=30              per-user chat budget
//   RL_FORCE_MEMORY=(unset)         set to 1 to force per-process limiter (tests/dev)
// ─────────────────────────────────────────────────────────────────────────────

// Trust proxy to get correct protocol (https) from X-Forwarded-Proto header
// when behind a reverse proxy/load balancer that terminates SSL. Numeric hop
// count (not blanket `true`) so req.ip / the rate-limiter key can't be spoofed
// via a forged X-Forwarded-For chain (feature 010, FR-014/RD-5). Default 1
// (immediate ingress / dev); prod sets TRUST_PROXY_HOPS=2 (CloudFront+Traefik).
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));

// HTTP golden-signal metrics (feature 014, US3/FR-011): record request count +
// duration by (route template, status class) on response finish. Mounted first
// so it times the whole request. Never throws into the request path.
const telemetryMetrics = require('./telemetry/metrics');
app.use(telemetryMetrics.httpMetricsMiddleware());

// Reject malformed URLs early (e.g. /%c0 — invalid UTF-8 from scanners)
// Express's router calls decodeURIComponent on path params, which throws
// URIError for invalid sequences. Catch it before it reaches the router.
app.use((req, res, next) => {
  try {
    decodeURIComponent(req.path);
    next();
  } catch (e) {
    res.status(400).end();
  }
});

// Security headers
// Feature 058: the directives, the old-domain redirect, and the page routes
// live in server/web-routes.js, gated on SQUIRE_HOSTED (Google sources and the
// 301 exist only on the hosted service; img-src carries the S3 origin only for
// the S3 driver).
app.use(helmet({
  contentSecurityPolicy: {
    directives: buildCspDirectives({ hosted: instanceConfig.hosted, storage: imageStorage }),
  },
  crossOriginEmbedderPolicy: false,
}));

// Redirect old domains to squiredocs.com (hosted only)
app.use(oldDomainRedirect);

// Client URL for CORS: CLIENT_URL, else APP_URL (feature 058, FR-010). The two
// localhost origins below stay allowed for the Vite and direct dev workflows.
const CLIENT_URL = instanceConfig.clientUrl;

// CORS configuration - allow credentials for cookies
const CORS_ALLOWED_ORIGINS = new Set([
  CLIENT_URL,
  'http://localhost:5173',
  'http://localhost:3001',
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // MCP endpoints use Bearer token auth (not cookies), so allow any origin
  const isMcpRoute = req.path.startsWith('/mcp') || req.path.startsWith('/.well-known/');
  if (origin === CLIENT_URL
    || isMcpRoute
    || (process.env.NODE_ENV === 'development')
    || CORS_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Parse JSON bodies (skip routes that set their own larger limit:
// /api/chat, and document image uploads which carry base64-encoded bytes)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/chat')) return next();
  if (req.method === 'POST' && /^\/api\/docs\/[^/]+\/images$/.test(req.path)) return next();
  // The 021 render-skip beacon sets its own SMALLER limit (8kb) at the route.
  if (req.path === '/api/collab/render-skip-report') return next();
  express.json()(req, res, next);
});

// Parse form-encoded bodies (required for OAuth token requests)
app.use(express.urlencoded({ extended: true }));

// Parse cookies for refresh token
app.use(cookieParser());

// PostgreSQL connection configuration
// Supports connection string or individual config values
const POSTGRES_CONFIG = process.env.DATABASE_URL || {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'collab_db',
  user: process.env.DB_USER || process.env.USER || 'postgres',
  password: process.env.DB_PASSWORD || ''
};

// Initialize PostgreSQL persistence
const persistenceProvider = new PostgresPersistence(POSTGRES_CONFIG);

// Register PG pool observable gauges (feature 014, US3/FR-013): total / idle /
// waiting connection counts, sampled on the metric collection interval.
telemetryMetrics.init({ getPool: () => persistenceProvider.getPool() });

// Pending-persistence tracker (feature 010, US1/FR-004). Every in-flight Yjs
// persistence promise registered by the bindState update listener lives here so
// the graceful-shutdown routine can await them before exit — no acknowledged
// edit is lost on a rolling deploy. Promises add themselves on start and remove
// themselves on settle (see the update listener below). flushPendingWrites LOOPS
// until the set drains so an edit queued mid-flush (the user's last keystrokes
// at SIGTERM) is also awaited, not lost (feature 010 review F4).
const { pendingWrites, flushPendingWrites } = createPendingWrites();

// Set up persistence layer for y-websocket
// y-websocket expects a persistence object with bindState and writeState methods
// bindState is async but not awaited by y-websocket - it applies persisted state when it completes
// Note: y-websocket calls it "docName" but we use it as a UUID (docGuid)
setPersistence({
  // Feature 043 (X1): the bindState body and its update listener now live in
  // server/collab-bind-state.js so tests can drive the real attribution path
  // instead of re-implementing it. Move-only — behavior is unchanged.
  bindState: createBindState({
    persistenceProvider,
    pendingWrites,
    notifyException,
    searchIndexer,
    collabGuardrail,
    logPerf,
  }),
  writeState: async () => {},
  provider: persistenceProvider
});

// Initialize user authentication with shared database pool
// (initUsers also wires the feature-034 auth-event trail to the same pool).
initUsers(persistenceProvider.getPool());

// Feature 034 (FR-010): retention for the auth-event trail — one sweep now,
// then a daily tick. The timer is unref()'d, so it never holds the process open
// during a drain; stopPurgeJob is still handed to the shutdown routine below so
// the teardown is explicit.
authEvents.startPurgeJob();

// Initialize documents module with shared database pool
documents.init(persistenceProvider.getPool());

// Initialize document images metadata module with shared database pool
documentImages.init(persistenceProvider.getPool());

// Initialize onboarding/welcome flow with shared database pool
onboarding.init(persistenceProvider.getPool());

// Initialize chat store with shared database pool
chatStore.init(persistenceProvider.getPool());

// Initialize AI usage metering with shared database pool
aiUsage.init(persistenceProvider.getPool());

// Feature 021 US2: guardrail reads recent agent-attributed rows through the
// shared pool (detection-only; wired fire-and-forget in the bindState
// persistence listener above). Feature 045 also hands it the persistence
// provider, which is the reader interface the resupply resolver uses to tell
// whether a fresh sync-relayed row carries agent content.
collabGuardrail.init(persistenceProvider.getPool(), persistenceProvider);

// Initialize chat module with the persistence provider (BYOK lookups + the
// document update log used for concurrent-edit awareness)
chat.init(persistenceProvider);

// Initialize BYOK settings with shared database pool
byokSettings.init(persistenceProvider.getPool());

// Initialize admin module with shared database pool
admin.init(persistenceProvider.getPool());

// Initialize app-wide settings and warm the in-memory cache (shared-assistant
// default model, read synchronously on the chat hot path). Non-blocking: until
// the cache loads, resolveChatModel falls back to the env/constant default.
appSettings.init(persistenceProvider.getPool());

// Initialize support module with shared database pool
support.init(persistenceProvider.getPool());

// Initialize spaces (feature 053) — data layer and its REST router
spaces.init(persistenceProvider.getPool());
spacesApi.init(persistenceProvider.getPool());

// Initialize MCP module with persistence provider
mcp.init(persistenceProvider);

// Initialize search modules
search.init(persistenceProvider.getPool());
searchIndexer.init(persistenceProvider);
setTimeout(() => searchIndexer.reindexStale(), 10_000);

// Initialize diff service for version history. It fetches diff rows through the
// persistence provider's gap-tolerant choke point (023 C1/FR-009), not a raw pool.
const diffService = new DiffService(persistenceProvider);

// Mount auth routes — per-IP rate limit on the whole /auth surface (feature 010,
// US2/FR-005). Keyed on the true client IP (numeric trust proxy above).
app.use('/auth', rateLimit.perIp('auth'), authRouter);

// Chat attachment upload (feature 010, US3). Mounted BEFORE the /api/chat body
// parser so a legitimately large image (up to 15MB → ~20MB base64) isn't
// rejected by the chat route's tighter CHAT_BODY_LIMIT. Its own router carries
// the larger parser scoped to this one route.
app.use(createChatAttachmentsRouter());

// Chat inline JSON body limit (feature 010, US3/FR-017, RD-6): shrunk 150MB →
// CHAT_BODY_LIMIT (default 10mb). Attachment bytes now travel the S3 path
// (POST /api/chat/attachments) as references, not inline base64, so a realistic
// text-only conversation stays well under the limit. An over-limit body is
// rejected 413 with an actionable message by the error handler below.
app.use('/api/chat', express.json({ limit: process.env.CHAT_BODY_LIMIT || '10mb' }), chat.router);
app.use('/api/settings/byok', express.json(), byokSettings.router);
app.use('/api/admin', requireAdmin, admin.router);
app.use('/api/support', express.json(), support.router);
// Spaces (feature 053). express.json() is NOT global in this app, so the body
// parser is attached at the mount — never at an /api/docs prefix, which would
// run it for the 20MB image route too (research R8).
app.use('/api/spaces', express.json(), spacesApi.router);

// Client runtime configuration (feature 021, DR-2). Authenticated read of a
// server-owned boolean — the binding-hardening kill-switch delivered to the
// browser at app bootstrap (client/src/hooks/useClientConfig.js). Absent
// setting = true (default ON, fail-safe: a failed fetch also leaves the
// client hardened).
app.get('/api/client-config', requireAuth, async (req, res) => {
  // Fresh DB read so a kill-switch flip reaches every replica at the next page
  // load, not just the pod that served the admin PUT (feature 021 review
  // MEDIUM-2). Bootstrap-only — never on the render hot path.
  res.json({ collabBindingHardening: await appSettings.getCollabBindingHardeningFresh() });
});

/**
 * Render-skip beacon (feature 021, DR-3): the patched editor binding reports
 * skip/stand-in events so divergence classes (invalid composites,
 * mixed-version clients) are observable server-side within minutes instead of
 * anecdote-discovered. Trust boundary (Constitution V): untrusted client
 * input — auth required, 8 KB body cap, shape-validated, content-free by
 * construction (node type names / error class names / counts — never document
 * text or attributes), rate-limited per user. Emits one structured log line
 * per report and increments the collab.render_skip.reports OTel counter on
 * the feature-014 metrics spine. Never mutates document state.
 */
app.post(
  '/api/collab/render-skip-report',
  requireAuth,
  rateLimit.perUser('collabSkip'),
  express.json({ limit: '8kb' }),
  (req, res) => {
    const bad = (msg) => res.status(400).json({ error: msg });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Malformed report');
    const { docId, bindingVersion, events } = body;
    if (Object.keys(body).length !== 3) return bad('Unexpected report fields');
    if (typeof docId !== 'string' || docId.length === 0 || docId.length > 64) return bad('Invalid docId');
    if (typeof bindingVersion !== 'string' || bindingVersion.length === 0 || bindingVersion.length > 64) {
      return bad('Invalid bindingVersion');
    }
    if (!Array.isArray(events) || events.length === 0 || events.length > 20) return bad('Invalid events');
    for (const ev of events) {
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return bad('Invalid event');
      if (Object.keys(ev).length !== 3) return bad('Unexpected event fields');
      if (typeof ev.nodeType !== 'string' || ev.nodeType.length === 0 || ev.nodeType.length > 64) {
        return bad('Invalid event nodeType');
      }
      if (typeof ev.errorName !== 'string' || ev.errorName.length === 0 || ev.errorName.length > 64) {
        return bad('Invalid event errorName');
      }
      if (!Number.isInteger(ev.count) || ev.count < 1 || ev.count > 1000000) {
        return bad('Invalid event count');
      }
    }
    console.log(
      `[CollabSkipReport] doc=${docId} user=${req.user.userId} bindingVersion=${bindingVersion} events=${JSON.stringify(events)}`
    );
    for (const ev of events) {
      telemetryMetrics.recordCollabRenderSkip(ev.nodeType, ev.errorName, ev.count);
    }
    res.sendStatus(204);
  }
);

// OAuth 2.0 Authorization Server Metadata (RFC 8414)
// Required for MCP client discovery of OAuth capabilities
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  console.log('[OAuth Discovery] Metadata requested from:', req.get('origin') || req.get('referer') || 'unknown');
  const baseUrl = buildBaseUrl(req);
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/mcp/auth/authorize`,
    token_endpoint: `${baseUrl}/mcp/auth/token`,
    revocation_endpoint: `${baseUrl}/mcp/auth/revoke`,
    registration_endpoint: `${baseUrl}/mcp/auth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['documents:read', 'documents:write'],
  });
});

// OAuth 2.0 Protected Resource Metadata (RFC 9728)
// Both the path-suffix form (/mcp) and the root fallback return byte-identical
// JSON describing the MCP endpoint as a protected resource, referencing this
// origin as its authorization server. Feature 005-agent-onboarding.
function buildProtectedResourceDoc(req) {
  const baseUrl = buildBaseUrl(req);
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: ['documents:read', 'documents:write'],
    bearer_methods_supported: ['header'],
    resource_name: 'Squire Docs MCP',
  };
}

app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  console.log('[OAuth Discovery] Protected-resource metadata (mcp) requested from:', req.get('origin') || req.get('referer') || 'unknown');
  res.json(buildProtectedResourceDoc(req));
});

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  console.log('[OAuth Discovery] Protected-resource metadata (root) requested from:', req.get('origin') || req.get('referer') || 'unknown');
  res.json(buildProtectedResourceDoc(req));
});

// Mount MCP OAuth routes first (more specific path takes precedence)
app.use('/mcp/auth', mcp.oauthRouter);

// Mount MCP routes
app.use('/mcp', mcp.router);

// OAuth callback endpoint (displays authorization code)
app.get('/oauth-callback', (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Escape values for safe HTML interpolation
  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  if (error) {
    const safeMessage = escapeHtml(error_description || error);
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authorization Failed</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 100px auto; padding: 20px; text-align: center; }
            .error { background: #ffebee; color: #c62828; padding: 20px; border-radius: 8px; }
          </style>
        </head>
        <body>
          <div class="error">
            <h2>❌ Authorization Failed</h2>
            <p>${safeMessage}</p>
          </div>
        </body>
      </html>
    `);
  }

  const safeCode = escapeHtml(code);
  const jsonData = JSON.stringify({ code: code || '', state: state || '' })
    .replace(/</g, '\\u003c');

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Authorization Successful</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 100px auto; padding: 20px; }
          .success { background: #e8f5e9; color: #2e7d32; padding: 20px; border-radius: 8px; margin-bottom: 20px; text-align: center; }
          .code-box { background: #f5f5f5; padding: 20px; border-radius: 8px; }
          code { background: #fff; padding: 10px; display: block; margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; word-break: break-all; }
          button { background: #7c3aed; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; margin-top: 10px; }
          button:hover { background: #6d28d9; }
        </style>
      </head>
      <body>
        <div class="success">
          <h2>✅ Authorization Successful!</h2>
          <p id="message">Sending code to parent window...</p>
        </div>
        <div class="code-box">
          <strong>Authorization Code:</strong>
          <code id="authCode">${safeCode}</code>
          <button onclick="copyCode()">Copy Code</button>
        </div>
        <script>
          var __oauthData = ${jsonData};

          function copyCode() {
            var code = document.getElementById('authCode').textContent;
            navigator.clipboard.writeText(code).then(function() {
              alert('Code copied to clipboard!');
            });
          }

          // If opened in a popup, send the code to the parent window
          if (window.opener && !window.opener.closed) {
            try {
              window.opener.postMessage({
                type: 'oauth_callback',
                code: __oauthData.code,
                state: __oauthData.state
              }, window.location.origin);
              document.getElementById('message').textContent = 'Code sent! You can close this window.';

              // Auto-close after 2 seconds
              setTimeout(function() {
                window.close();
              }, 2000);
            } catch (err) {
              console.error('Failed to send message to parent:', err);
              document.getElementById('message').textContent = 'Copy the code below and paste it in the test page.';
            }
          } else {
            document.getElementById('message').textContent = 'Copy the authorization code below to exchange for tokens.';
          }
        </script>
      </body>
    </html>
  `);
});

// Serve static files from client build directory
const clientBuildPath = path.join(__dirname, '../client/dist');

// Health check endpoint — pure liveness (feature 010, US4/FR-022). Stays 200 as
// long as the process is up, even when the datastore is unreachable. No
// dependency checks, no secrets, rate-limit-exempt.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness endpoint (feature 010, US4). Reports whether THIS replica should
// receive traffic. Unauthenticated and rate-limit-exempt (FR-012); mounted
// before any limiter middleware so it is never throttled. 200 iff the process
// finished startup, is not draining, and Postgres answers a trivial query
// within a short timeout. Redis/cache state is reported but never gates the
// decision (RD-4/FR-021). Body carries no secrets/versions/hostnames (FR-022).
// Feature 011 later repoints the k8s readinessProbe here.
app.get('/ready', createReadyHandler({ lifecycle, persistenceProvider, redisPubSub, isRedisReady }));

// API: Get AI usage quota for the current user
app.get('/api/usage', requireAuth, async (req, res) => {
  try {
    const quota = await aiUsage.checkQuota(req.user.userId);
    res.json(quota);
  } catch (err) {
    console.error('[Usage] Error fetching quota:', err);
    notifyException(err, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to fetch usage data' });
  }
});

// API: List documents accessible by the current user
// Query params: search, filter, sortBy, sortOrder, limit, offset
app.get('/api/docs', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { search: searchQuery, searchMode, filter, sortBy, sortOrder, limit, offset, mode, distanceThreshold } = req.query;

    // Space scope (feature 053, FR-026/FR-040). Omitting it leaves the result
    // set exactly as it was before spaces existed. A bad value is a 400, never
    // a silently unfiltered list.
    let space;
    try {
      space = documents.normalizeSpaceScope(req.query.space);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // Feature 017: validate updatedAfter up front — before the rate limiter —
    // so misuse 400s cheaply (spending no search quota) and is never silently
    // ignored (CN-3). Valid recency-filtered searches stay metered below.
    let updatedAfter;
    if (req.query.updatedAfter !== undefined) {
      try {
        updatedAfter = search.parseUpdatedAfter(req.query.updatedAfter, {
          hasContentSearch: !!(searchQuery && searchMode === 'content'),
        });
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    // Content search: delegate to the search module for hybrid FTS + vector search.
    // Per-user rate limit (feature 010, US2/FR-006) applies only to the expensive
    // content-search branch — plain title search is unmetered.
    if (searchQuery && searchMode === 'content') {
      if (!(await rateLimit.enforceUser('search', req, res))) return; // 429 sent

      const results = await search.searchDocuments(userId, searchQuery, {
        mode: mode || 'hybrid',
        filter: filter || 'all',
        sortBy: sortBy || 'relevance',
        sortOrder: sortOrder || 'desc',
        limit: limit ? parseInt(limit, 10) : 10,
        offset: offset ? parseInt(offset, 10) : 0,
        distanceThreshold: distanceThreshold ? parseFloat(distanceThreshold) : undefined,
        updatedAfter,
        space,
      });

      const docs = results.rows.map((doc) => ({
        docGuid: doc.doc_id,
        title: doc.title || null,
        updatedAt: doc.updated_at,
        role: doc.role,
        ownerName: doc.owner_name,
        ownerEmail: doc.owner_email,
        snippet: doc.snippet,
        score: doc.score,
        shareCount: doc.share_count,
        spaceId: doc.space_id || null,
        spaceName: doc.space_name || null,
      }));

      return res.json({ docs, pagination: results.pagination });
    }

    // Default: title-based search
    const { rows: accessibleDocs, total } = await documents.getAccessibleDocuments(userId, {
      search: searchQuery || null,
      filter: filter || 'all',
      sortBy: sortBy || 'updatedAt',
      sortOrder: sortOrder || 'desc',
      limit: limit ? parseInt(limit, 10) : null,
      offset: offset ? parseInt(offset, 10) : 0,
      space,
    });

    // Transform to response format
    const docs = accessibleDocs.map((doc) => ({
      docGuid: doc.doc_id,
      title: doc.title || null,
      updatedAt: doc.updated_at || doc.created_at,
      role: doc.role,
      ownerName: doc.owner_name,
      ownerEmail: doc.owner_email,
      shareCount: parseInt(doc.share_count, 10) || 0,
      spaceId: doc.space_id || null,
      spaceName: doc.space_name || null,
    }));

    // Include pagination info if limit was specified
    const response = { docs };
    if (limit) {
      response.pagination = {
        total,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10) || 0,
        hasMore: (parseInt(offset, 10) || 0) + docs.length < total,
      };
    }

    res.json(response);
  } catch (error) {
    console.error('Error fetching documents:', error);
    notifyException(error, { req, source: 'api' });
    const errorMessage = error.message || 'Failed to fetch documents';
    const hint = errorMessage.includes('doc_guid')
      ? ' (Have you run the migration? npm run migrate)'
      : '';
    res.status(500).json({ error: errorMessage + hint });
  }
});

// API: Create a new document (establishes ownership)
app.post('/api/docs', requireAuth, async (req, res) => {
  try {
    const { docId, spaceId = null } = req.body;
    const userId = req.user.userId;
    
    if (!docId) {
      return res.status(400).json({ error: 'docId is required' });
    }
    
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(docId)) {
      return res.status(400).json({ error: 'Invalid docId format' });
    }
    
    // Check if document already exists
    const existingDoc = await documents.getDocument(docId);
    if (existingDoc) {
      // Document exists - check if user has access
      const hasAccess = await documents.hasAccess(docId, userId);
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const role = await documents.getRole(docId, userId);
      return res.json({ doc: existingDoc, role, created: false });
    }
    
    // Creating directly INTO a space (feature 053, FR-044) is authorized by the
    // same rule as moving one in: editor-or-owner membership of the target. The
    // creator still receives a direct owner share, so their access never
    // depends on that membership surviving.
    if (spaceId) {
      const memberRole = await spaces.getMemberRole(spaceId, userId);
      if (!memberRole) {
        return res.status(404).json({ error: 'Space not found' });
      }
      if (documents.ROLES[memberRole] < documents.ROLES.editor) {
        return res.status(403).json({ error: 'You must be an editor or owner of the target space' });
      }
    }

    // Create the document with this user as owner
    const doc = await documents.createDocument(docId, userId, null, spaceId);
    // Creating a real (non-welcome) doc means the user is now engaged — stamp
    // onboarded_at now instead of waiting for their next login/_auth/me probe.
    // Best-effort: never block or fail creation on the onboarding stamp.
    onboarding.markEngagedFromDocCreation(userId).catch(() => {});
    res.status(201).json({ doc, role: 'owner', created: true });
  } catch (error) {
    console.error('Error creating document:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to create document' });
  }
});

// API: Move a document into a space, out of one, or between two (feature 053).
//
// An ~8-line adapter over spaces.moveDocument(), which owns the whole D7 rule
// set and runs it in one transaction under a row lock. The route lives inline
// here rather than in server/api/spaces.js so it sits with its 23 sibling
// /api/docs routes (research R8); its own express.json() is attached because
// the parser is NOT global and must never be mounted at the /api/docs prefix
// (that would consume the 20MB image route's body).
app.put('/api/docs/:docId/space', requireAuth, express.json(), async (req, res) => {
  try {
    const result = await spaces.moveDocument(
      req.user.userId,
      req.params.docId,
      req.body?.spaceId ?? null
    );
    res.json(result);
  } catch (error) {
    if (typeof error.status === 'number') {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Error moving document:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to move document' });
  }
});

// API: Get document info
app.get('/api/docs/:docId', requireAuth, async (req, res) => {
  try {
    const { docId } = req.params;
    const userId = req.user.userId;
    
    // Get user's role
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const doc = await documents.getDocument(docId);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Feature 053: the editor shows the document's space as a chip, and offers
    // "Move to space" only to a DIRECT owner (FR-041) — a passthrough owner
    // must not see it, for the same reason moveDocument refuses them.
    const space = doc.space_id ? await spaces.getSpace(doc.space_id) : null;
    const { rows: directRows } = await persistenceProvider.getPool().query(
      'SELECT role FROM document_shares WHERE doc_id = $1 AND user_id = $2',
      [docId, userId]
    );

    res.json({
      doc: {
        id: doc.id,
        createdAt: doc.created_at,
        updatedAt: doc.updated_at,
        spaceId: doc.space_id || null,
        spaceName: space?.name || null,
      },
      role,
      directRole: directRows[0]?.role || null,
    });
  } catch (error) {
    console.error('Error getting document:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to get document' });
  }
});

// API: Delete a document (owner only)
app.delete('/api/docs/:docId', requireAuth, async (req, res) => {
  try {
    const { docId } = req.params;
    const userId = req.user.userId;
    
    // Check delete permission (owner only)
    const canDelete = await permissions.can.delete(userId, docId);
    if (!canDelete.allowed) {
      return res.status(403).json({ error: canDelete.reason });
    }
    
    // Delete Yjs data
    await persistenceProvider.clearDocument(docId);

    // Delete the document's image bytes from image storage (S3 or the local
    // driver; DB rows cascade with the document). Best-effort: a failure here
    // shouldn't block document deletion.
    try {
      await documentImages.deleteImageBytesForDoc(docId);
    } catch (cleanupError) {
      console.error('Error deleting document images from image storage:', cleanupError);
      notifyException(cleanupError, { req, source: 'api' });
    }

    // Delete document record and shares
    const deleted = await documents.deleteDocument(docId);
    if (!deleted) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting document:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// Document image upload, resolve, and raw byte routes (feature 058: moved
// into server/api/document-images-routes.js so tests mount the production
// router; the upload route keeps its own 20mb JSON parser, and the global
// parser above still skips that path).
app.use(createDocumentImagesRouter({ documents, documentImages, storage: imageStorage, notifyException }));

// API: Search registered users for the share autocomplete
app.get('/api/users/search', requireAuth, async (req, res) => {
  try {
    const query = (req.query.q || '').trim();
    const { docId } = req.query;

    // Require a couple of characters to avoid dumping the whole user table.
    if (query.length < 2) {
      return res.json({ users: [] });
    }

    const users = await documents.searchUsers(query, {
      excludeUserId: req.user.userId,
      excludeDocId: docId || null,
    });

    res.json({ users });
  } catch (error) {
    console.error('Error searching users:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// API: Share document with a user by email
//
// A thin adapter over shareDocumentByEmail() — the ONE sharing behavior, shared
// with the MCP `share_document` tool (feature 053 FR-029). All the logic that
// used to live here (role validation, the access check, the viewer rule, the
// pending-invite branch, the email_enabled gate, the awaited sends) moved to
// server/share-service.js unchanged.
app.post('/api/docs/:docId/share', requireAuth, async (req, res) => {
  try {
    const { docId } = req.params;
    const { email, role = 'editor' } = req.body;

    const { status, body } = await shareDocumentByEmail({
      actor: req.user,
      docId,
      email,
      role,
      baseUrl: buildBaseUrl(req),
    });
    res.status(status).json(body);
  } catch (error) {
    console.error('Error sharing document:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to share document' });
  }
});

// API: Update a user's role
//
// A thin adapter over shareDocumentByEmail's siblings in
// server/share-service.js, where the target-owner guard lives once.
app.put('/api/docs/:docId/share/:targetUserId', requireAuth, async (req, res) => {
  try {
    const { docId, targetUserId } = req.params;
    const { status, body } = await changeRole({
      actor: req.user,
      docId,
      targetUserId,
      role: req.body?.role,
    });
    res.status(status).json(body);
  } catch (error) {
    console.error('Error updating role:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// API: Remove a user's access
app.delete('/api/docs/:docId/share/:targetUserId', requireAuth, async (req, res) => {
  try {
    const { docId, targetUserId } = req.params;
    const { status, body } = await removeUserAccess({
      actor: req.user,
      docId,
      targetUserId,
    });
    res.status(status).json(body);
  } catch (error) {
    console.error('Error removing access:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to remove access' });
  }
});

// API: Remove a pending share invite (by email)
app.delete('/api/docs/:docId/invite', requireAuth, async (req, res) => {
  try {
    const { docId } = req.params;
    const { email } = req.body;
    const userId = req.user.userId;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    // Check manage permission (editors and owners can manage)
    const canManage = await permissions.can.manage(userId, docId);
    if (!canManage.allowed) {
      return res.status(403).json({ error: canManage.reason });
    }

    const removed = await documents.removeInvite(docId, email);
    if (!removed) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing invite:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to remove invite' });
  }
});

// API: Get all users with access to a document
app.get('/api/docs/:docId/shares', requireAuth, async (req, res) => {
  try {
    const { docId } = req.params;
    const userId = req.user.userId;

    // Check if user has access
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    const users = await documents.getDocumentUsers(docId);
    const invites = await documents.getInvitesForDoc(docId);

    // Feature 053 (FR-043): if the document lives in a space, say so — as a
    // READ-ONLY line. `users` / `invites` / `currentUserRole` are untouched:
    // the dialog still manages DIRECT shares only, and space membership is
    // managed on the space page (RBD-053-15).
    const doc = await documents.getDocument(docId);
    let spaceGrant = null;
    if (doc?.space_id) {
      const space = await spaces.getSpace(doc.space_id);
      if (space) {
        spaceGrant = {
          id: space.id,
          name: space.name,
          role: await spaces.getMemberRole(space.id, userId),
          memberCount: (await spaces.getMembers(space.id)).length,
        };
      }
    }

    res.json({
      users,
      invites,
      currentUserRole: role,
      spaceGrant,
    });
  } catch (error) {
    console.error('Error getting shares:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to get shares' });
  }
});

// ==================== Version History API ====================

// API: Get version history timeline for a document
app.get('/api/docs/:docId/history', requireAuth, rateLimit.perUser('versionHistory'), async (req, res) => {
  try {
    const { docId } = req.params;
    const userId = req.user.userId;

    // Check if user has at least view access
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    const timeline = await versionHistory.getVersionTimeline(persistenceProvider, docId);
    res.json(timeline);
  } catch (error) {
    console.error('Error getting version history:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to get version history' });
  }
});

// API: Get individual updates within a clock range (for drill-down)
app.get('/api/docs/:docId/history/updates', requireAuth, rateLimit.perUser('versionHistory'), async (req, res) => {
  try {
    const { docId } = req.params;
    const { from, to } = req.query;
    const userId = req.user.userId;

    const clockStart = parseInt(from, 10);
    const clockEnd = parseInt(to, 10);

    if (isNaN(clockStart) || isNaN(clockEnd)) {
      return res.status(400).json({ error: 'from and to query parameters are required and must be numbers' });
    }

    // Check if user has at least view access
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    const result = await versionHistory.getUpdatesForVersion(persistenceProvider, docId, clockStart, clockEnd);
    // Pass hasMore/total through so the client can honestly indicate when a
    // version has more edits than were returned (server limit defaults to 10).
    res.json({ updates: result.subversions, total: result.total, hasMore: result.hasMore });
  } catch (error) {
    console.error('Error getting version updates:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to get version updates' });
  }
});

// API: Get document content at a specific clock value
app.get('/api/docs/:docId/history/clock/:clock', requireAuth, rateLimit.perUser('versionHistory'), async (req, res) => {
  try {
    const { docId, clock } = req.params;
    const userId = req.user.userId;

    const clockValue = parseInt(clock, 10);
    if (isNaN(clockValue)) {
      return res.status(400).json({ error: 'clock parameter must be a number' });
    }

    // Check if user has at least view access
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    const content = await versionHistory.getContentAtClock(persistenceProvider, docId, clockValue);
    res.json(content);
  } catch (error) {
    console.error('Error getting content at clock:', error);
    if (error instanceof versionHistory.VersionNotFoundError) {
      return res.status(404).json({ error: error.message });
    }
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to get content at clock' });
  }
});

// API: Get full document with history for version diff comparison
// Returns the full document (gc:false) and snapshots at specified clock positions
app.get('/api/docs/:docId/history/diff', requireAuth, rateLimit.perUser('versionHistory'), async (req, res) => {
  try {
    const { docId } = req.params;
    const { currentClock, previousClock } = req.query;
    const userId = req.user.userId;

    // Validate parameters
    const current = parseInt(currentClock, 10);
    if (isNaN(current)) {
      return res.status(400).json({ error: 'currentClock parameter must be a number' });
    }

    // previousClock is optional (absent => -1, "diff against empty"). When
    // present it must be numeric — otherwise a NaN would be baked into the Redis
    // diff cache key — and cannot exceed currentClock (that inverts the diff).
    let previous = -1;
    if (previousClock !== undefined && previousClock !== '') {
      previous = parseInt(previousClock, 10);
      if (isNaN(previous)) {
        return res.status(400).json({ error: 'previousClock parameter must be a number' });
      }
      if (previous > current) {
        return res.status(400).json({ error: 'previousClock must not be greater than currentClock' });
      }
    }

    // Check if user has at least view access
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    // Compute diff server-side (with Redis caching)
    const result = await diffService.computeDiff(docId, previous, current);
    res.json(result);
  } catch (error) {
    console.error('Error getting diff data:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to get diff data' });
  }
});

// API: Export a document as Markdown (downloadable file) — see api/docs-export.js
app.use(createExportRouter(persistenceProvider));

// API: Import markdown — POST /api/docs/import (create) and
// PUT /api/docs/:docId/import (append|replace) — see api/docs-import.js
app.use(createImportRouter(persistenceProvider));

// API: One-shot claim for create_access_token mints — GET /api/tokens/claim.
// Authenticated by the claim secret (Bearer header), not requireAuth.
// See api/token-claim.js
app.use(createTokenClaimRouter());

// API: Get document content at a specific version
app.get('/api/docs/:docId/versions/:versionId', requireAuth, rateLimit.perUser('versionHistory'), async (req, res) => {
  try {
    const { docId, versionId } = req.params;
    const userId = req.user.userId;

    // Check if user has at least view access
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    const versionData = await versionHistory.getVersionContent(persistenceProvider, docId, versionId);
    res.json(versionData);
  } catch (error) {
    console.error('Error getting version content:', error);
    if (error instanceof versionHistory.VersionNotFoundError) {
      return res.status(404).json({ error: error.message });
    }
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to get version content' });
  }
});

// API: Restore document to a previous version (creates new version)
app.post('/api/docs/:docId/restore', requireAuth, rateLimit.perUser('versionHistory'), async (req, res) => {
  try {
    const { docId } = req.params;
    const { versionId } = req.body;
    const userId = req.user.userId;

    if (!versionId) {
      return res.status(400).json({ error: 'versionId is required' });
    }

    // Check if user has edit access
    const role = await documents.getRole(docId, userId);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'You do not have permission to restore this document' });
    }

    // Restore via the shared core (feature 023 US5): a human UI restore is
    // attributed to the human, and broadcasts on every instance via the shared
    // live-apply path (loaded-doc apply or Redis fan-out — never a silent skip).
    //
    // `agentName: null` marks this as a human restore: it is recorded in the
    // update log under the requesting user and is NOT entered into any
    // identity's undo queue. Reverting it is done by restoring again. See the
    // rationale in versionHistory.restoreVersion.
    // FR-013: the PEEK, never the creating lookup. Restore only needs to know
    // whether the doc is already live here; asking with `getSharedDoc` created
    // (and permanently leaked) an in-memory doc for every restore of a document
    // nobody had open.
    const result = await versionHistory.restoreVersion(persistenceProvider, docId, versionId, userId, {
      getSharedDoc: documentService.peekSharedDoc,
      redisPubSub,
      agentName: null,
    });
    res.json(result);
  } catch (error) {
    console.error('Error restoring version:', error);
    if (error instanceof versionHistory.VersionNotFoundError) {
      return res.status(404).json({ error: error.message });
    }
    // F3 (023 FR-009/D-2): a still-gapped log is a transient sync condition, not
    // a server fault — fail closed with 503 so the client retries in a moment.
    if (error instanceof versionHistory.DocumentSyncingError) {
      return res.status(503).json({ error: error.message });
    }
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to restore version' });
  }
});

// API: Undo / Redo the chat assistant's last edit to a document.
//
// Unlike restore (which reverts to a point in time and discards later edits),
// these derive a true surgical inverse from the durable yjs_updates log
// (feature 016): the edit's recorded clock range is inverted and applied as a
// normal forward update. No session is involved — undo works from any
// instance, at any time, across restarts, and never creates a presence
// session. We rebuild the assistant's synthetic agent token (same user +
// agent id) so executeTool resolves the same acting identity the modify was
// attributed to. Returns the tool result { success, undone|redone, message,
// clock } — clock is the inverse's new log clock on success, the current max
// on the honest-empty path (RBD-5). `undone:false` means there was honestly
// nothing (left) to undo: no recorded edit, fully superseded, or a concurrent
// request got there first (contracts/http-undo-api.md).
function makeUndoRedoHandler(toolName, label) {
  return async (req, res) => {
    try {
      const { docId } = req.params;
      const userId = req.user.userId;

      const role = await documents.getRole(docId, userId);
      if (!role || role === 'viewer') {
        return res.status(403).json({ error: `You do not have permission to ${label} this document` });
      }

      const token = chat.buildChatAgentToken(req);
      const result = await toolRegistry.executeTool(toolName, { docGuid: docId }, token);

      // Persist the reverted state on the chat message so the "Reverted" marker
      // survives reloads. Best-effort: never fail the undo/redo if this doesn't
      // stick. undo -> reverted, redo -> not reverted.
      //
      // ── VERIFIED STAMP (feature 041, FR-015) ─────────────────────────────
      // The card reference is CLIENT-SUPPLIED. Undo picks its target by LIFO
      // over the acting identity's records, which is not necessarily the edit
      // on the card the request names: a newer edit from another chat, or a
      // direct API call carrying an arbitrary toolCallId, would stamp
      // "Reverted" onto a card whose edit was never touched — a user-facing
      // attribution lie. So the stamp only lands when the card was recorded
      // against THIS document (`:docId`) and its own recorded edit range
      // matches the range of the record that was actually undone. Clocks are
      // per-document, so the document check is what makes the range check mean
      // anything (review M2). A card with NO stored document or NO stored range
      // (pre-016, or still editRangePending) is a MISMATCH by rule: absence of
      // evidence is not a pass.
      //
      // The undo/redo itself is never affected, and the HTTP response is
      // identical whether the stamp applied or was skipped. Nothing cut by
      // 040 D19 is revived here — this is a read-and-compare at the stamp
      // site, not undo scoping and not an offer guard.
      const succeeded = toolName === 'undo' ? result.undone : result.redone;
      if (succeeded && req.body?.chatId && req.body?.toolCallId) {
        try {
          const recordRange = toolName === 'undo' ? result.undoneRecordRange : result.redoneRecordRange;
          await setChatPartReverted(
            req.body.chatId, userId, req.body.toolCallId, toolName === 'undo',
            { expectedRange: recordRange, docGuid: docId, label }
          );
        } catch (e) {
          console.warn(`[${label}] could not persist reverted flag:`, e.message);
        }
      }

      res.json(result);
    } catch (error) {
      console.error(`Error during ${label}:`, error);
      notifyException(error, { req, source: 'api' });
      res.status(500).json({ error: `Failed to ${label} document` });
    }
  };
}

// The verified "Reverted" stamp lives in server/api/chat-revert-stamp.js so the
// comparison rule is unit-testable without booting the server (feature 041,
// FR-015).
const setChatPartReverted = (chatId, userId, toolCallId, reverted, opts) =>
  chatRevertStamp.setChatPartReverted({ chatStore }, chatId, userId, toolCallId, reverted, opts);

app.post('/api/docs/:docId/undo', requireAuth, makeUndoRedoHandler('undo', 'undo'));
app.post('/api/docs/:docId/redo', requireAuth, makeUndoRedoHandler('redo', 'redo'));

// API: Whether the chat assistant's edit can currently be undone/redone for a
// document. Log-derived (feature 016, FR-019/RBD-6): two indexed agent_edits
// lookups for the chat-assistant identity (user + CHAT_AGENT_NAME) — no
// presence-session dependency, peek, or creation of any kind. Availability
// therefore survives session expiry and server restarts for as long as the
// edit genuinely remains undoable: the Undo button no longer disappears on
// session expiry. canUndo is cheap availability, not a supersession proof —
// a fully superseded edit surfaces the honest "nothing left to undo" at
// action time and the client re-polls after every action. Returns
// { canUndo, canRedo }; viewer-role and error responses stay both-false.
// The handler lives in server/api/undo-status.js (feature 043, X4) — its suite
// used to test a hand-copied replica that had already drifted from it. Mounted
// here in the same style as the other api/ routers.
app.use(createUndoStatusRouter({ documents, undoService, requireAuth }));

// API: Create a named version
app.post('/api/docs/:docId/versions', requireAuth, rateLimit.perUser('versionHistory'), async (req, res) => {
  try {
    const { docId } = req.params;
    const { name, clockEnd } = req.body;
    const userId = req.user.userId;

    // Validate name: required, non-empty (after trim), ≤255 chars.
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name is required and must be a non-empty string' });
    }
    const trimmedName = name.trim();
    if (trimmedName.length > 255) {
      return res.status(400).json({ error: 'name must be 255 characters or fewer' });
    }

    // Validate clockEnd when present: a positive integer. Guard the request BEFORE
    // the old `clockEnd || latest` fallback, which treated clockEnd:0 (and any
    // non-numeric value coercing falsy) as "name the latest version" silently.
    const hasClockEnd = clockEnd !== undefined && clockEnd !== null;
    if (hasClockEnd && (!Number.isInteger(clockEnd) || clockEnd <= 0)) {
      return res.status(400).json({ error: 'clockEnd must be a positive integer' });
    }

    // Check if user has at least view access (anyone can name a version)
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    // Get updates to find the clock range
    const updates = await persistenceProvider.getUpdatesWithUsers(docId);
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates found for this document' });
    }

    // If clockEnd is provided, use it; otherwise use current (latest) clock.
    const targetClock = hasClockEnd ? clockEnd : updates[updates.length - 1].clock;

    // Find the version boundaries using time-based grouping
    const versions = versionHistory.groupUpdatesIntoVersions(updates);

    // Find the auto version that contains the target clock
    const containingVersion = versions.find(v =>
      v.clockStart <= targetClock && v.clockEnd >= targetClock
    );

    // Determine the clock range for the named version
    let versionClockStart, versionClockEnd;

    if (hasClockEnd) {
      // Naming a specific clock — it must fall inside a real version range.
      // An explicit clockEnd that is out of range (or lands in a gap between
      // versions) is a client error, not a silent "name the latest" fallback.
      if (!containingVersion) {
        return res.status(400).json({
          error: `clockEnd ${targetClock} is out of range for this document`,
        });
      }
      // The named version includes everything from the start of the containing
      // auto version up to the named clock, "breaking" the auto version.
      versionClockStart = containingVersion.clockStart;
      versionClockEnd = targetClock;
    } else if (containingVersion) {
      // Naming the current version - use the full auto version boundaries
      versionClockStart = containingVersion.clockStart;
      versionClockEnd = containingVersion.clockEnd;
    } else {
      // No explicit clockEnd and no containing version for the latest clock
      // (degenerate) — fall back to the target clock.
      versionClockStart = targetClock;
      versionClockEnd = targetClock;
    }

    const version = await persistenceProvider.createNamedVersion(
      docId,
      versionClockStart,
      versionClockEnd,
      trimmedName,
      userId
    );

    res.status(201).json({ version });
  } catch (error) {
    console.error('Error creating named version:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to create named version' });
  }
});

// API: Rename a version
app.put('/api/docs/:docId/versions/:versionId', requireAuth, rateLimit.perUser('versionHistory'), async (req, res) => {
  try {
    const { docId, versionId } = req.params;
    const { name } = req.body;
    const userId = req.user.userId;

    // Check if user has at least view access
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    // Verify the version belongs to this document (also enforced doc-scoped in SQL)
    const existingVersion = await persistenceProvider.getVersionById(versionId, docId);
    if (!existingVersion) {
      return res.status(404).json({ error: 'Version not found' });
    }

    const version = await persistenceProvider.updateVersionName(versionId, name, docId);
    res.json({ version });
  } catch (error) {
    console.error('Error renaming version:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to rename version' });
  }
});

// API: Delete a named version (returns to auto-grouping)
app.delete('/api/docs/:docId/versions/:versionId', requireAuth, rateLimit.perUser('versionHistory'), async (req, res) => {
  try {
    const { docId, versionId } = req.params;
    const userId = req.user.userId;

    // Check if user has at least view access
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    // Verify the version belongs to this document (also enforced doc-scoped in SQL)
    const existingVersion = await persistenceProvider.getVersionById(versionId, docId);
    if (!existingVersion) {
      return res.status(404).json({ error: 'Version not found' });
    }

    const deleted = await persistenceProvider.deleteNamedVersion(versionId, docId);
    if (!deleted) {
      return res.status(404).json({ error: 'Version not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting version:', error);
    notifyException(error, { req, source: 'api' });
    res.status(500).json({ error: 'Failed to delete version' });
  }
});

// Marketing, legal, and blog pages (hosted only), documentation, static files,
// /agents.md, and the injected app shell (feature 058, server/web-routes.js).
// Falls back to a "build the client" page when client/dist is missing.
mountWebRoutes(app, { clientBuildPath });

// Express error-handling middleware (safety net for unhandled errors)
app.use((err, req, res, next) => {
  // Body-parser failures are client errors, not server faults: malformed JSON
  // (entity.parse.failed) → 400, oversized body → 413. Without this, a JSON
  // typo in any API call returned 500 and paged the exception notifier.
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    if (!res.headersSent) {
      const tooLarge = err.type === 'entity.too.large';
      // For an oversized chat body, point the caller at the attachment path
      // (feature 010, US3/FR-017) instead of a generic message.
      const isChat = typeof req.originalUrl === 'string' && req.originalUrl.startsWith('/api/chat');
      const tooLargeMessage = isChat
        ? 'Request body too large. Upload attachments via POST /api/chat/attachments and send references instead of inline image data.'
        : 'Request body too large';
      res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? tooLargeMessage : 'Malformed request body',
      });
    }
    return;
  }
  console.error('Unhandled Express error:', err);
  notifyException(err, { req, source: 'express-middleware' });
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create HTTP server
// Fail fast at boot if the BYOK encryption keyring is misconfigured (malformed
// API_KEY_ENCRYPTION_KEYS, a dangling primary, or a missing key in production).
// Otherwise a bad keyring surfaces only at first BYOK use; failing here crashes
// the pod so a bad rollout halts (maxUnavailable:0) instead of serving 500s.
require('./crypto').validateKeyring();

const server = app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready on ws://localhost:${PORT}/s`);

  // Log WebSocket simulator status
  wsSimulator.logStatus();

  // Initialize document service with y-websocket functions. `docs` (the
  // registry) is passed alongside the creating `getYDoc` so `peekSharedDoc` can
  // answer "is this loaded?" without creating anything (feature 041, FR-013).
  documentService.init(getYDoc, extractDocGuid, docs);

  // Let resupply resolution recognise THIS instance's own shared-doc client
  // identity (feature 045 review, N-045-2). Content created on the shared doc
  // carries one client identity for whoever acts through the server, so it
  // determines no author and must never bind one. Read-only and creating
  // nothing: `peekSharedDoc` answers null when the document is not loaded here.
  resupplyResolution.init({ peekSharedDoc: documentService.peekSharedDoc });

  // Feature 057 (FR-005/FR-013): bound documents reconcile against Postgres on
  // a cheap periodic check. Started BEFORE — and independently of — Redis,
  // deliberately: fan-out delivery is an optimisation, and with Redis disabled
  // or down this timer is the entire convergence mechanism. Its steady-state
  // cost is one batched newest-clock query per period, whatever the number of
  // bound documents.
  collabReconcile.startPeriodicCheck({ docs, persistence: persistenceProvider });

  // ...and once more the moment the subscriber becomes usable. A reconnect
  // restores the channel subscriptions but replays nothing published while the
  // socket was down, so that window is invisible divergence until something
  // checks. Registered before init() so the first connect counts too.
  redisPubSub.onSubscriberReady(() => collabReconcile.reconcileAllBoundDocs({
    docs,
    persistence: persistenceProvider,
  }));

  // Initialize Redis pub/sub for cross-instance synchronization
  // Await to ensure Redis is ready before accepting WebSocket connections
  try {
    await redisPubSub.init();
  } catch (err) {
    console.error('[RedisPubSub] Failed to initialize:', err.message);
    notifyException(err, { source: 'redis-init' });
  }

  // Startup finished — mark the process ready so GET /ready flips 503 → 200
  // (feature 010, US4/scenario 4). Redis pub/sub init failure does not block
  // readiness (RD-4: Postgres gates, cache is reported-not-gating).
  lifecycle.markInitialized();
});

// Largest inbound WebSocket frame the collaboration socket will reassemble.
//
// `ws` defaults to 100 MiB, which is a memory-amplification primitive: any
// authenticated viewer on any readable document can make the process buffer
// that much per frame, repeatedly, on every connection it opens (feature 044
// post-merge review, HIGH-3). The CPU half of that finding is fixed in the
// awareness guard (it refuses an over-count frame before walking it); this is
// the memory half, and it also bounds every OTHER frame type.
//
// The largest LEGITIMATE frame is a sync step2 carrying a whole document's Yjs
// state. Uploaded images are stored out of band and referenced by URL
// (client/src/utils/uploadImage.js), so the only inline bytes a document can
// hold are rasterised diagrams, capped at ~1 MB PNG each before base64
// (client/src/extensions/diagramShared.js RASTER_MAX_BYTES). 32 MB is therefore
// roughly twenty maximum-size diagrams of headroom above anything this editor
// can produce, at a third of the default. Overridable because the failure mode
// — a 1009 close and a reconnect loop — is nasty to diagnose from the client.
const WS_MAX_PAYLOAD_BYTES = parseInt(process.env.WS_MAX_PAYLOAD_BYTES || '', 10) || 32 * 1024 * 1024;

// Create WebSocket server attached to HTTP server
// Using noServer mode to handle custom path matching
const wss = new WebSocket.Server({
  noServer: true,
  maxPayload: WS_MAX_PAYLOAD_BYTES,
});

// Handle upgrade requests - mount WebSocket at /s/* to support document-specific paths
// y-websocket clients append document names: /s/default-doc, /s/my-doc, etc.
server.on('upgrade', async (request, socket, head) => {
  try {
  // Refuse new upgrades while draining (feature 010, US1/FR-001): the pod is
  // shutting down, so clients should fail over to a healthy replica rather than
  // attach to a session that's about to close.
  if (lifecycle.isDraining()) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;

  // Only accept WebSocket connections that start with /s/
  if (!pathname.startsWith('/s/')) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // Extract document ID from path: /s/{docId}
  const docId = pathname.slice(3); // Remove '/s/'

  // Parse cookies from request headers (cookie-parser middleware doesn't run on upgrade)
  const cookies = parseCookies(request.headers.cookie);

  // Try cookie first, then query param (for backwards compatibility & MCP agents)
  const cookieToken = cookies.accessToken;
  const queryToken = url.searchParams.get('token');
  if (!cookieToken && queryToken) {
    console.warn(`[WS] Token passed via query parameter for doc ${docId} — prefer cookie auth`);
  }
  const token = cookieToken || queryToken;
  const user = await permissions.extractUser({ queryToken: token });

  if (!user) {
    console.error('❌ WebSocket auth failed: no valid token for doc', docId);
    console.error('   → This usually means the user\'s session has expired');
    console.error('   → User should refresh the page to log in again');
    socket.write('HTTP/1.1 401 Unauthorized\r\nX-Auth-Error: Invalid or expired token\r\n\r\n');
    socket.destroy();
    return;
  }

  // Check if user has at least view access
  const viewPermission = await permissions.can.view(user.userId, docId);
  if (!viewPermission.allowed) {
    console.error(`❌ WebSocket access denied for user ${user.userId} to doc ${docId}: ${viewPermission.reason}`);
    console.error('   → User does not have permission to access this document');
    socket.write('HTTP/1.1 403 Forbidden\r\nX-Auth-Error: Access denied\r\n\r\n');
    socket.destroy();
    return;
  }

  // Store user info and role on the request for later use
  request.user = user;
  request.userRole = viewPermission.role;
  request.docId = docId;
  // Token scope is the SECOND authorization axis, and it binds here exactly as
  // it does on REST (server/auth/middleware.js `checkScopes`). Scoped principals
  // — sk_sqd_ API tokens and agent JWTs — carry a `scopes` array; browser
  // session JWTs carry none and are unrestricted, which is why the absence of
  // the array means "allowed" rather than "denied".
  //
  // Without this, a token minted with the DEFAULT scope set (`documents:read`,
  // see server/mcp/tools/create-access-token.js) could open this socket and
  // write: the connection gate below derived edit capability from the document
  // ROLE alone, so a read-only token belonging to an editor wrote freely. REST
  // refused the same principal on the same document. Attribution stayed correct
  // — it was an authorization hole, not a misattribution one.
  request.tokenMayWrite = !Array.isArray(user.scopes) || user.scopes.includes('documents:write');

  wss.handleUpgrade(request, socket, head, (ws) => {
    // Apply connection simulation if enabled
    const wrappedWs = wsSimulator.simulateFlakyConnection(ws);
    wss.emit('connection', wrappedWs, request);
  });
  } catch (err) {
    // A thrown lookup here (extractUser / can.view against a down database)
    // must answer the socket, not die as an unhandledRejection. Since 046
    // closes degraded editors with 1013, an outage sends every one of them
    // back through this handler on ~2.5s retry loops — unguarded, that is one
    // page per attempt through the process-level handler (draining the shared
    // notification budget the per-doc throttles protect) and a TCP socket left
    // dangling until the client's own timeout. 503 keeps the client backing
    // off and retrying, the same contract as the drain refusal above.
    console.error('[WS] upgrade failed:', err?.message || err);
    try {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    } catch { /* socket may already be gone */ }
    socket.destroy();
  }
});

// Presence cleanup note (feature 038 US5): this file used to hand-parse clientIds
// out of the first awareness frame a connection sent (`parseAwarenessClientIds` +
// a `connectionClientId` capture) and explicitly evict that id on close. That
// capture was wrong by construction — an awareness frame is a broadcast ABOUT a
// set of clients, not necessarily FROM the sender, so a connection that arrived
// after someone else's awareness broadcast adopted the WRONG id and evicted the
// wrong participant on disconnect. It is deleted. Presence eviction is now solely
// y-websocket's `closeConn`, which calls removeAwarenessStates with the
// per-connection CONTROLLED-IDS set it maintains — exactly the ids each
// connection actually announced. (The Redis pub/sub cleanup that shared the close
// handler is preserved; see the close handler below.)
//
// AWARENESS FRAMES ARE PARSED AGAIN (feature 044) — and this is NOT that bug
// coming back. The deleted code asked "which id does the SENDER own?", which a
// broadcast-about-a-set frame simply cannot answer. The 044 guard, in
// server/ws-awareness-guard.js, asks the opposite and answerable question:
// "WHICH IDS DOES THIS FRAME ASSERT?" — exactly what such a frame does tell you
// — and refuses the frame when a connection asserts an id another user's
// connection owns. Two things stay true regardless: eviction still comes solely
// from `closeConn` plus y-websocket's controlled-ids set, and that set is READ
// by the guard and never written, so y-websocket remains its sole maintainer.
// No parsing happens in this file; see the C1 structural guards in
// server/__tests__/ws-edit-gate.test.js, which fail if any reappears.

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  const connId = ++messageCounter;
  const connStart = Date.now();
  const userRole = req.userRole;
  const userId = req.user?.userId;
  const docId = req.docId;
  // BOTH axes. The role can change under us (re-checked every 60s below); the
  // token's scopes are fixed for the life of the connection, so a scope-denied
  // principal can never become writable without reconnecting.
  const tokenMayWrite = req.tokenMayWrite !== false;
  let currentCanEdit = tokenMayWrite && documents.ROLES[userRole] >= documents.ROLES['editor'];

  // Feature 046 (NEW-1): is the CURRENT `currentCanEdit === false` the result of
  // a failed re-check rather than a role verdict? The re-check below fails
  // closed, which is right for safety and catastrophic for durability if the
  // dropped frames are merely swallowed — see the "silent divergence" note in
  // server/ws-edit-gate.js. Only this scope knows which of the two happened, so
  // it is recorded here and read by the gate when a frame is actually dropped.
  // Starts false: the handshake capability above IS a verdict.
  let editCapabilityDegraded = false;

  // Sanitize URL to remove token from logs
  const sanitizedUrl = req.url?.split('?')[0] || req.url;

  logPerf('WS_CONNECT', { connId, url: sanitizedUrl, role: userRole, canEdit: currentCanEdit });
  console.log(`✓ WebSocket connection established [connId=${connId}]: ${sanitizedUrl} (role: ${userRole}, userId: ${userId})`);

  // Store attribution info on ws for the update handler
  // y-websocket passes ws as origin to ydoc.on('update')
  // The derivation lives in server/agent-identity.js (feature 043, X2) so a test
  // can drive the real thing; a re-declared copy of it would guard nothing.
  // Reading identity from the authenticated principal — never from awareness —
  // is the fix eulogised above.
  const wsIdentity = identityFromPrincipal(req.user);
  ws.userId = wsIdentity.userId;
  ws.agentName = wsIdentity.agentName;

  // Setup ping/pong keepalive mechanism
  let isAlive = true;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Send ping every 5 seconds (reduced from 30s to quickly detect stale connections)
  // This helps clean up awareness states from page refreshes faster
  const PING_INTERVAL = 5000; // 5 seconds
  const pingInterval = setInterval(() => {
    if (ws.isAlive === false) {
      console.log(`✗ WebSocket connection ${connId} appears dead, terminating`);
      logPerf('WS_TIMEOUT', { connId, duration: Date.now() - connStart });
      clearInterval(pingInterval);
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  }, PING_INTERVAL);

  // Note: a per-message token expiry check was removed because tokenExp is frozen
  // at connection time and never updates when the client refreshes its access
  // token. That caused WebSocket disconnects after 15 minutes even though the
  // user had a valid session. The periodic role re-check (every 60s) handles
  // access revocation, and the client reconnects with fresh cookies on auth errors.

  // The shared Yjs doc for this connection's document, resolved lazily below
  // (feature 044). The gate is installed BEFORE setupWSConnection — 038's
  // wiring, and its structural guards, depend on that order — so the doc handle
  // does not exist yet at install time. Until it does, `getConns` returns null
  // and the awareness guard stands down, which is safe: with no message
  // listener attached yet, a frame cannot reach any applier.
  let sharedDoc = null;

  // Install the sync-protocol edit gate (feature 038 US1). It classifies each
  // frame, drops edit frames from connections that may not edit — SYNC_UPDATE
  // and SYNC_STEP2 alike, since both reach Y.applyUpdate — and scopes the step2
  // channel-marker flag around frame application. `canEdit` is read per frame so
  // the 60s role re-check below (which fails closed) governs step2 exactly as it
  // governs update frames. See server/ws-edit-gate.js for the classification
  // table and the synchronicity assumption behind the flag window.
  installGate(ws, {
    canEdit: () => currentCanEdit,
    // Feature 046 (NEW-1): read ONLY when an edit frame is dropped. True means
    // "this connection is still believed editor-capable and we are refusing on
    // an error" ⇒ the gate closes with 1013 and the client re-supplies on
    // reconnect, instead of diverging silently and forever.
    editCapabilityDegraded: () => editCapabilityDegraded,
    // Feature 044: the ownership view for the awareness guard, resolved per
    // frame. y-websocket stays the sole maintainer of `doc.conns` (the guard
    // only reads it); the ledger alongside it is the guard's own record of
    // which principal may speak as which clientID, and it lives on the doc, so
    // it dies with the doc.
    getOwnership: () => (sharedDoc ? awarenessOwnershipFor(sharedDoc) : null),
    onBlocked: (event, info = {}) => {
      // Feature 044: an awareness frame refused for asserting someone else's
      // clientID. Already rate-suppressed per connection by the gate, so this
      // fires at most once per window; the counts in `info` are what keeps the
      // suppressed volume recoverable. Distinct wording from the edit-block
      // line below because it is a different accusation: this connection tried
      // to speak AS another participant, whatever its edit permission.
      if (event === 'WS_AWARENESS_BLOCKED') {
        const { reason, foreignIds, conflicts, dropped, sinceLastLog } = info;
        // `conflicts` names the HOLDING principal beside the asserting one.
        // Without it the line accuses whoever sent the frame, which on a
        // squatted clientID is the victim, not the squatter (review MEDIUM-4).
        logPerf(event, {
          connId, userId, docId, role: userRole, reason, foreignIds, conflicts, dropped, sinceLastLog,
        });
        // `sinceLastLog`, not 1 and not `dropped`. This line is rate-suppressed
        // per connection, so counting CALLS would undercount during a flood —
        // but `dropped` is the connection's running TOTAL, and adding a running
        // total to a counter sums every emission's cumulative (a connection
        // refused across 60 windows reports ~30x). `sinceLastLog` is the delta
        // this emission represents and is reset immediately after, so the sum
        // over emissions is exactly the number of frames dropped.
        // After the cross-pod vouching fix this should fall to roughly zero —
        // if it does not, legitimate reconnects are still being refused, and
        // that verdict only works if the number means what it says.
        telemetryMetrics.recordAwarenessBlocked(reason, sinceLastLog);
        console.log(
          `✗ Awareness frame blocked (${reason}): user ${userId} asserted clientIds [${foreignIds}] `
          + `it does not control on doc ${docId} (held by `
          + `[${(conflicts || []).map((c) => c.heldBy.join('|')).join(', ')}], `
          + `dropped=${dropped} on this connection)`
        );
        return;
      }

      logPerf(event, { connId, userId, docId, role: userRole });
      const what = event === 'WS_STEP2_BLOCKED' ? 'Sync step2 (catch-up) frame' : 'Edit';
      console.log(`✗ ${what} blocked for viewer ${userId} on doc ${docId}`);
    },
  });

  ws.on('error', (error) => {
    logPerf('WS_ERROR', { connId, error: error.message });
    console.error('✗ WebSocket client error:', error.message);
    notifyException(error, { source: 'websocket', extra: { connId, docId, userId } });
  });

  // Periodically re-check document role from DB (catches role downgrades)
  const ROLE_RECHECK_INTERVAL = 60000;
  const roleCheckInterval = setInterval(async () => {
    try {
      // The decision lives in documents.evaluateAccessRecheck so it can be
      // exercised without a socket or a 60-second wait; the side effects stay
      // here. Since feature 053 a removed space member, a deleted space and a
      // moved-out document all reach `revoked` through the same path a revoked
      // direct share already did.
      const { revoked, canEdit } = await documents.evaluateAccessRecheck(docId, userId, tokenMayWrite);
      if (revoked) {
        console.log(`[WS:${connId}] User ${userId} lost access to doc ${docId}, disconnecting`);
        ws.close(4403, 'Access revoked');
        return;
      }
      currentCanEdit = canEdit;
      // A successful re-check is a VERDICT: whatever `currentCanEdit` now says
      // is backed by the DB. If it says false, this is a genuine downgrade and
      // the gate's drop-and-stay-open policy is the correct answer.
      editCapabilityDegraded = false;
    } catch (err) {
      console.error(`[WS:${connId}] Role re-check failed:`, err.message);
      // Feature 046 (NEW-1). Fail closed as before — but REMEMBER that this
      // false is an error, not a verdict, so the gate can close the connection
      // rather than silently swallowing this editor's frames. The distinction is
      // sticky across repeated failures: once degraded, a connection stays
      // degraded until a re-check actually succeeds, because every subsequent
      // failure leaves `currentCanEdit` already false and would otherwise look
      // indistinguishable from an honest viewer.
      const believedCapable = currentCanEdit || editCapabilityDegraded;
      currentCanEdit = false; // Fail closed — block edits until next successful recheck
      editCapabilityDegraded = believedCapable;
      if (believedCapable) {
        logPerf('WS_EDIT_CAPABILITY_DEGRADED', { connId, userId, docId, role: userRole });
        // 046 is built on the assumption that this is rare. Counting it is how
        // that assumption gets checked instead of trusted.
        telemetryMetrics.recordEditCapabilityDegraded();
      }
    }
  }, ROLE_RECHECK_INTERVAL);

  ws.on('close', () => {
    clearInterval(pingInterval);
    clearInterval(roleCheckInterval);
    logPerf('WS_CLOSE', { connId, duration: Date.now() - connStart });
    console.log('WebSocket connection closed:', sanitizedUrl);
  });
  
  // ONE document name, derived once and passed to BOTH sides (review LOW-6).
  // y-websocket's default name is `req.url.slice(1).split('?')[0]` — the RAW
  // request target — while `docId` comes from the NORMALISED `URL.pathname` that
  // authorization was checked against. For `/s/../s/X` those differ, so the
  // connection would bind to one document while the guard read another's
  // ownership, and the authorized document would not be the one being edited.
  // Passing the name removes the divergence by construction rather than
  // asserting the two happen to agree.
  const wsDocName = `s/${docId}`;

  try {
    setupWSConnection(ws, req, {
      gc: true,
      docName: wsDocName
    });
    logPerf('WS_SETUP_COMPLETE', { connId });

    // The SAME doc instance y-websocket is using — same name, same registry.
    const doc = getYDoc(wsDocName, true);
    // From here the awareness guard (feature 044) can see who owns which
    // clientID on this document. See the `getConns` handler above.
    sharedDoc = doc;

    if (docId && doc) {
      // Debug: Log connection state
      const connsCount = doc.conns ? doc.conns.size : 0;
      const awarenessCount = doc.awareness ? doc.awareness.getStates().size : 0;
      console.log(`[WS:${connId}] Connected to doc ${docId} (wsName: ${wsDocName}): ${connsCount} conns, ${awarenessCount} awareness states`);

      // ========== REDIS PUB/SUB SYNC ==========
      // Set up cross-instance synchronization via Redis (once per doc instance)
      if (!doc._redisSyncInitialized && redisPubSub.isEnabled()) {
        doc._redisSyncInitialized = true;
        console.log(`[RedisPubSub] Setting up sync for doc ${docId}`);

        // Subscribe to Redis channels for this document.
        //
        // Feature 057 (FR-005): this call is deliberately NOT awaited, which
        // leaves a window between the bind load and the first delivered message
        // in which another pod's edits reach nobody here. Reconciling once the
        // subscription is actually established closes it. Chained rather than
        // awaited so the connection path keeps its current timing, and
        // error-swallowed because a failed repair is retried by the periodic
        // check anyway.
        redisPubSub.subscribeToDocument(docId, {
          // Handle awareness updates from other server instances
          onAwareness: (buffer, owners) => {
            try {
              // BEFORE the apply (multi-replica review M4): the publishing
              // instance authenticated these participants and vouches for them,
              // so the ledger records their real principal instead of the
              // "somebody remote" placeholder. Without this, the same user
              // reconnecting onto THIS instance is refused permission to speak
              // as their own clientID and goes invisible. Teaching first means
              // the record is already right when the apply fires the ledger's
              // own listener.
              awarenessLearnRelayedOwners(doc, owners);
              awarenessProtocol.applyAwarenessUpdate(
                doc.awareness,
                new Uint8Array(buffer),
                ORIGIN_REDIS
              );
            } catch (err) {
              console.error(`[RedisPubSub] Error applying awareness update for ${docId}:`, err.message);
            }
          },
          // Handle document updates from other server instances
          onUpdate: (buffer) => {
            try {
              Y.applyUpdate(doc, new Uint8Array(buffer), ORIGIN_REDIS);
            } catch (err) {
              console.error(`[RedisPubSub] Error applying doc update for ${docId}:`, err.message);
            }
          },
        })
          // `reconcileIfBound`, not `reconcileDoc`: SUBSCRIBE acks in
          // milliseconds while the bind's load takes tens to hundreds, so on a
          // doc's first load this fires MID-BIND. There is no blind window to
          // close at that point — the subscriber's onUpdate above is already
          // applying fan-out into this doc — and reconciling a doc with no
          // verified clock would fetch the whole log with bytes alongside the
          // bind's own load, then race the binder for the clock. See the
          // rationale on reconcileIfBound in collab-reconcile.js.
          .then(() => collabReconcile.reconcileIfBound(docId, doc, {
            persistence: persistenceProvider,
            docs,
          }))
          .catch((err) => {
            console.warn(`[reconcile] post-subscribe pass failed for ${docId}:`, err?.message || err);
          });

        // Publish local awareness changes to Redis for other instances
        const redisAwarenessHandler = ({ added, updated, removed }, origin) => {
          // Skip if update came from Redis (prevent feedback loops)
          if (origin === ORIGIN_REDIS) return;

          // `removed` MUST be included: a client that clears its state
          // (setLocalState(null) — e.g. an agent presence session silenced on
          // claim loss, feature 015 — or a ws-close eviction) is reported here
          // and encodeAwarenessUpdate encodes its null state, which removes it
          // on every receiving instance. Dropping `removed` (the pre-2026-07-18
          // behavior) meant remote instances/browsers never heard about the
          // removal and showed a ghost presence until y-protocols' 30s
          // staleness prune — observed in prod as persisting duplicate agent
          // avatars during the 015 validation.
          const changedClients = added.concat(updated).concat(removed);
          if (changedClients.length > 0) {
            try {
              const update = awarenessProtocol.encodeAwarenessUpdate(
                doc.awareness,
                changedClients
              );
              // Vouch for the ones that are OURS (multi-replica review M4), so
              // the receiving instance can tell this user's own reconnect from
              // a stranger asserting their clientID. Ids we only relayed are
              // omitted; nothing else about the message changes, and an
              // instance running the previous build reads it identically.
              redisPubSub.publishAwareness(
                docId, update, awarenessLocalOwnersOf(doc, changedClients)
              );
            } catch (err) {
              console.error(`[RedisPubSub] Error publishing awareness for ${docId}:`, err.message);
            }
          }
        };

        // Publish local document updates to Redis for other instances
        const redisUpdateHandler = (update, origin) => {
          // Skip ONLY Redis (feedback loop) and DB-load (already everywhere)
          // updates. A two-way-sync push arrives with ORIGIN_SYNC_PUSH, which is
          // deliberately NOT on this skip-list (F3): it must fan out to other
          // instances that have the doc loaded, or their live editors never see
          // the push. Its persistence double-store is suppressed elsewhere
          // (parseOrigin returns null), so publishing it here is safe.
          // The predicate lives in server/origin.js (feature 043, X3); its suite
          // used to mirror this skip-list by hand.
          if (!shouldPublishToRedis(origin)) return;

          try {
            redisPubSub.publishUpdate(docId, update);
          } catch (err) {
            console.error(`[RedisPubSub] Error publishing update for ${docId}:`, err.message);
          }
        };

        // Register handlers
        doc.awareness.on('update', redisAwarenessHandler);
        doc.on('update', redisUpdateHandler);

        // Store handlers for cleanup
        doc._redisAwarenessHandler = redisAwarenessHandler;
        doc._redisUpdateHandler = redisUpdateHandler;
      }
      // ========== END REDIS PUB/SUB SYNC ==========

      if (doc.awareness) {
        // Clean up on close - explicitly remove this connection's awareness
        ws.on('close', () => {
          // Awareness eviction is y-websocket's job (closeConn -> controlled ids,
          // feature 038 US5) — this handler must NOT evict anything itself. What
          // it still owns is the Redis pub/sub teardown below (FR-024).

          // ========== REDIS PUB/SUB CLEANUP ==========
          // If no more local connections, unsubscribe from Redis
          // Use setImmediate to allow pending connection handling to complete first
          // This prevents race conditions with rapid disconnect/reconnect cycles
          setImmediate(() => {
            // Double-check connection count at cleanup time to handle reconnections.
            //
            // The count alone is not enough. `unsubscribeFromDocument` is keyed by
            // NAME, not by doc identity, while this closure holds ONE doc instance
            // forever. A refused bind (refuseBind, FR-010) closes the conns and
            // CLEARS the map, so a straggler close from an already-dead connection
            // sees size === 0 on the OLD doc — long after a reconnect built a fresh
            // doc under the same name and subscribed it. Unsubscribing then kills
            // the LIVE doc's channels, and nothing re-subscribes (the fresh doc has
            // `_redisSyncInitialized` set), so it silently stops seeing other
            // instances' updates. Only tear down when the registry still points at
            // (or has forgotten) this handler's own doc.
            const isCurrentDoc = !docs.has(wsDocName) || docs.get(wsDocName) === doc;
            if (doc.conns.size === 0 && isCurrentDoc && redisPubSub.isEnabled()) {
              console.log(`[RedisPubSub] No more connections for doc ${docId}, cleaning up`);

              redisPubSub.unsubscribeFromDocument(docId);
              doc._redisSyncInitialized = false;

              // Remove Redis handlers
              if (doc._redisAwarenessHandler) {
                doc.awareness.off('update', doc._redisAwarenessHandler);
                doc._redisAwarenessHandler = null;
              }
              if (doc._redisUpdateHandler) {
                doc.off('update', doc._redisUpdateHandler);
                doc._redisUpdateHandler = null;
              }
            } else if (doc.conns.size > 0) {
              console.log(`[RedisPubSub] Skipping cleanup for doc ${docId}, ${doc.conns.size} connections remaining`);
            } else if (!isCurrentDoc) {
              console.log(`[RedisPubSub] Skipping cleanup for doc ${docId}: a newer doc instance owns this name`);
            }
          });
          // ========== END REDIS PUB/SUB CLEANUP ==========
        });
      }
    }
  } catch (error) {
    logPerf('WS_SETUP_ERROR', { connId, error: error.message });
    console.error('✗ Error setting up WebSocket connection:', error);
    notifyException(error, { source: 'websocket-setup', extra: { connId, docId, userId } });
    ws.close();
  }
});

// Handle WebSocket server errors
wss.on('error', (error) => {
  console.error('✗ WebSocket server error:', error);
  notifyException(error, { source: 'websocket-server' });
});

// Graceful shutdown (feature 010, US1). One ordered drain bound to both SIGTERM
// and SIGINT: flip the draining flag (readiness → 503, WS upgrades refused),
// close live sessions, await in-flight persistence, then tear down cleanly under
// a SHUTDOWN_DEADLINE_MS backstop below the orchestrator's 30s grace period.
const runShutdown = createShutdown({
  lifecycle,
  wss,
  flushPendingWrites,
  redisPubSub,
  persistenceProvider,
  closeRedis,
  telemetry,
  server,
  // Stop the recurring background timers on drain. Both are unref'd, so neither
  // holds the process open by itself; stopping them explicitly keeps the drain
  // honest about what is still running. (034: auth-event retention.
  // 057: the reconcile consistency check.)
  stopBackgroundJobs: () => {
    authEvents.stopPurgeJob();
    collabReconcile.stopPeriodicCheck();
  },
  deadlineMs: Number(process.env.SHUTDOWN_DEADLINE_MS ?? 20000),
});
process.on('SIGTERM', () => runShutdown('SIGTERM'));
process.on('SIGINT', () => runShutdown('SIGINT'));

// Export for internal use (MCP tools, tests)
module.exports = {
  getYDoc,
  // Feature 041 (FR-010/FR-013): y-websocket's doc registry — the honest
  // primitive behind bind eviction and the non-creating is-loaded peek.
  docs,
  extractDocGuid,
};
