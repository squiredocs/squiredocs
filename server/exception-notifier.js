/**
 * Exception email notifications — Rails exception_notification style.
 *
 * Sends HTML emails to ADMIN_EMAIL when unexpected errors occur.
 * Rate-limited to prevent floods. Fire-and-forget — never throws.
 * Gracefully degrades when email config is missing.
 */

const os = require('os');
const { sendEmail } = require('./email');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const sentTimestamps = [];

// Headers to exclude from email reports
const SENSITIVE_HEADERS = new Set([
  'cookie', 'authorization', 'x-api-key', 'x-auth-token',
]);

function isRateLimited() {
  const now = Date.now();
  while (sentTimestamps.length > 0 && sentTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    sentTimestamps.shift();
  }
  return sentTimestamps.length >= RATE_LIMIT_MAX;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatHeaders(headers) {
  if (!headers) return '';
  return Object.entries(headers)
    .filter(([key]) => !SENSITIVE_HEADERS.has(key.toLowerCase()))
    .map(([key, val]) => `<tr><td style="padding:2px 8px;color:#666">${escapeHtml(key)}</td><td style="padding:2px 8px">${escapeHtml(val)}</td></tr>`)
    .join('\n');
}

function formatExceptionEmail(error, context = {}) {
  const { req, source, extra } = context;
  const timestamp = new Date().toISOString();
  const errorName = error?.name || 'Error';
  const errorMessage = error?.message || String(error);
  const stack = error?.stack || '(no stack trace)';

  let requestSection = '';
  if (req) {
    const user = req.user;
    requestSection = `
    <h3 style="margin:16px 0 8px;color:#333">Request</h3>
    <table style="border-collapse:collapse;font-size:14px">
      <tr><td style="padding:2px 8px;font-weight:bold;color:#666">Method</td><td style="padding:2px 8px">${escapeHtml(req.method || '')}</td></tr>
      <tr><td style="padding:2px 8px;font-weight:bold;color:#666">URL</td><td style="padding:2px 8px">${escapeHtml(req.originalUrl || req.url || '')}</td></tr>
      <tr><td style="padding:2px 8px;font-weight:bold;color:#666">IP</td><td style="padding:2px 8px">${escapeHtml(req.ip || req.connection?.remoteAddress || '')}</td></tr>
      <tr><td style="padding:2px 8px;font-weight:bold;color:#666">User-Agent</td><td style="padding:2px 8px">${escapeHtml(req.headers?.['user-agent'] || '')}</td></tr>
      ${user ? `<tr><td style="padding:2px 8px;font-weight:bold;color:#666">User</td><td style="padding:2px 8px">${escapeHtml(user.userId || '')} / ${escapeHtml(user.email || '')}</td></tr>` : ''}
    </table>

    <h3 style="margin:16px 0 8px;color:#333">Headers</h3>
    <table style="border-collapse:collapse;font-size:12px">
      ${formatHeaders(req.headers)}
    </table>`;
  }

  let extraSection = '';
  if (extra && typeof extra === 'object') {
    const rows = Object.entries(extra)
      .map(([k, v]) => `<tr><td style="padding:2px 8px;color:#666">${escapeHtml(k)}</td><td style="padding:2px 8px">${escapeHtml(String(v))}</td></tr>`)
      .join('\n');
    extraSection = `
    <h3 style="margin:16px 0 8px;color:#333">Extra Context</h3>
    <table style="border-collapse:collapse;font-size:14px">${rows}</table>`;
  }

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:800px;margin:0 auto">
    <h2 style="color:#c0392b;margin-bottom:4px">${escapeHtml(errorName)}: ${escapeHtml(errorMessage)}</h2>

    <table style="border-collapse:collapse;font-size:14px;margin-bottom:16px">
      <tr><td style="padding:2px 8px;font-weight:bold;color:#666">Source</td><td style="padding:2px 8px">${escapeHtml(source || 'unknown')}</td></tr>
      <tr><td style="padding:2px 8px;font-weight:bold;color:#666">Time</td><td style="padding:2px 8px">${timestamp}</td></tr>
      <tr><td style="padding:2px 8px;font-weight:bold;color:#666">Environment</td><td style="padding:2px 8px">${escapeHtml(process.env.NODE_ENV || 'development')}</td></tr>
      <tr><td style="padding:2px 8px;font-weight:bold;color:#666">Host</td><td style="padding:2px 8px">${escapeHtml(os.hostname())}</td></tr>
      <tr><td style="padding:2px 8px;font-weight:bold;color:#666">PID</td><td style="padding:2px 8px">${process.pid}</td></tr>
      <tr><td style="padding:2px 8px;font-weight:bold;color:#666">Uptime</td><td style="padding:2px 8px">${Math.round(process.uptime())}s</td></tr>
    </table>

    ${requestSection}
    ${extraSection}

    <h3 style="margin:16px 0 8px;color:#333">Backtrace</h3>
    <pre style="background:#f8f8f8;border:1px solid #ddd;padding:12px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(stack)}</pre>
  </div>`;
}

/**
 * Send an exception notification email to the admin.
 * Fire-and-forget — never throws, never blocks.
 *
 * @param {Error|*} error - The error to report
 * @param {object} [context] - Optional context
 * @param {object} [context.req] - Express request object
 * @param {string} [context.source] - Where the error was caught (api, websocket, express-middleware, etc.)
 * @param {object} [context.extra] - Additional key/value pairs to include
 */
function notifyException(error, context = {}) {
  if (!ADMIN_EMAIL) return;

  if (isRateLimited()) {
    console.warn('[ExceptionNotifier] Rate limit reached — suppressing email for:', error?.message || error);
    return;
  }

  try {
    const errorMessage = error?.message || String(error);
    const errorName = error?.name || 'Error';
    const truncated = errorMessage.length > 80 ? errorMessage.substring(0, 80) + '...' : errorMessage;
    const subject = `[Squire Docs] ${errorName}: ${truncated}`;
    const html = formatExceptionEmail(error, context);

    sentTimestamps.push(Date.now());
    sendEmail({ to: ADMIN_EMAIL, subject, html });
  } catch (err) {
    console.error('[ExceptionNotifier] Failed to send notification:', err.message);
  }
}

/**
 * Register process-level error handlers (uncaughtException, unhandledRejection).
 * Call once at server startup.
 */
function setupProcessHandlers() {
  let handlingFatal = false;

  process.on('uncaughtException', (error) => {
    if (handlingFatal) return;
    handlingFatal = true;
    console.error('Uncaught exception:', error);
    notifyException(error, { source: 'uncaughtException' });
    setTimeout(() => process.exit(1), 2000);
  });

  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    console.error('Unhandled rejection:', error);
    notifyException(error, { source: 'unhandledRejection' });
  });
}

module.exports = { notifyException, setupProcessHandlers };
