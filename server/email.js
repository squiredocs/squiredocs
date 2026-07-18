/**
 * Email notifications via AWS SES SMTP
 * Fire-and-forget — never blocks HTTP responses, logs errors but never throws.
 * Gracefully skips if SES_FROM_EMAIL is not configured.
 */

const nodemailer = require('nodemailer');

/** Strip CR/LF to prevent email header injection */
const sanitizeHeader = (s) => String(s).replace(/[\r\n]/g, '');

const FROM_EMAIL = process.env.SES_FROM_EMAIL;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const SMTP_HOST = process.env.SES_SMTP_HOST || 'email-smtp.us-west-2.amazonaws.com';
const SMTP_USER = process.env.SES_SMTP_USER;
const SMTP_PASS = process.env.SES_SMTP_PASS;

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: 465,
      secure: true,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

/** Escape a string for safe interpolation into HTML. */
const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Send an email via SES SMTP. Never throws.
 * Returns a result object so callers that care (e.g. an admin-triggered send)
 * can report success/failure; fire-and-forget callers can ignore it.
 *   { ok: true, messageId }        — sent
 *   { ok: false, skipped: true }   — SES not configured
 *   { ok: false, error }           — send failed
 */
async function sendEmail({ to, subject, html, replyTo, bcc }) {
  if (!FROM_EMAIL) {
    console.warn('SES_FROM_EMAIL not set — skipping email:', subject);
    return { ok: false, skipped: true };
  }

  try {
    const message = { from: `Squire Docs <${FROM_EMAIL}>`, to, subject, html };
    if (replyTo) message.replyTo = sanitizeHeader(replyTo);
    if (bcc) message.bcc = bcc;
    const info = await getTransporter().sendMail(message);
    console.log('Email sent:', subject, '->', to, `(messageId: ${info.messageId})`);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error('Failed to send email:', subject, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Notify admin of a new user registration
 */
function notifyNewUser({ email, name }) {
  if (!ADMIN_EMAIL) return;
  const safeEmail = escapeHtml(email);
  const safeName = escapeHtml(name || '(not provided)');
  sendEmail({
    to: ADMIN_EMAIL,
    subject: `New user registered: ${sanitizeHeader(email)}`,
    html: `
      <h3>New user registration</h3>
      <p><strong>Email:</strong> ${safeEmail}</p>
      <p><strong>Name:</strong> ${safeName}</p>
    `,
  });
}

/**
 * Notify admin of a user login
 */
function notifyLogin({ email, name }) {
  if (!ADMIN_EMAIL) return;
  const safeEmail = escapeHtml(email);
  const safeName = escapeHtml(name || '(not provided)');
  sendEmail({
    to: ADMIN_EMAIL,
    subject: `User logged in: ${sanitizeHeader(email)}`,
    html: `
      <h3>User login</h3>
      <p><strong>Email:</strong> ${safeEmail}</p>
      <p><strong>Name:</strong> ${safeName}</p>
      <p><strong>Time:</strong> ${new Date().toISOString()}</p>
    `,
  });
}

/**
 * Notify admin when a user hits their AI credit limit.
 * Deduped: only one email per user per calendar month.
 */
const creditLimitNotified = new Set();

function notifyCreditLimitReached({ email, name, creditCents, usedCents }) {
  if (!ADMIN_EMAIL) return;
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const key = `${email}-${month}`;
  if (creditLimitNotified.has(key)) return;
  creditLimitNotified.add(key);

  const credit = (creditCents / 100).toFixed(2);
  const used = (usedCents / 100).toFixed(2);
  const safeEmail = escapeHtml(email);
  const safeName = escapeHtml(name || '(not provided)');
  sendEmail({
    to: ADMIN_EMAIL,
    subject: `AI credit limit reached: ${sanitizeHeader(email)}`,
    html: `
      <h3>AI credit limit reached</h3>
      <p><strong>Email:</strong> ${safeEmail}</p>
      <p><strong>Name:</strong> ${safeName}</p>
      <p><strong>Monthly allowance:</strong> $${credit}</p>
      <p><strong>Used this month:</strong> $${used}</p>
      <p><strong>Time:</strong> ${new Date().toISOString()}</p>
    `,
  });
}

/**
 * Notify admin of a new support request submitted from the Settings page.
 */
function notifySupportRequest({ email, name, message }) {
  if (!ADMIN_EMAIL) return;
  const safeEmail = escapeHtml(email);
  const safeName = escapeHtml(name || '(not provided)');
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
  sendEmail({
    to: ADMIN_EMAIL,
    replyTo: email,
    subject: `Support request from ${sanitizeHeader(email)}`,
    html: `
      <h3>New support request</h3>
      <p><strong>Email:</strong> ${safeEmail}</p>
      <p><strong>Name:</strong> ${safeName}</p>
      <p><strong>Time:</strong> ${new Date().toISOString()}</p>
      <hr>
      <p>${safeMessage}</p>
    `,
  });
}

/**
 * Send a "document shared with you" email. The invite variant (for people who
 * aren't signed up yet) adds a sign-in instruction; otherwise the body just
 * says they now have access. Both go to an arbitrary external address, so they
 * require SES production access.
 * @param {boolean} pending - true for a not-yet-registered invitee
 */
function sendShareEmail({ to, docTitle, inviterName, docUrl, replyTo, pending }) {
  const title = docTitle || 'Untitled document';
  const inviter = inviterName || 'Someone';
  const safeTitle = escapeHtml(title);
  const safeInviter = escapeHtml(inviter);
  const safeUrl = escapeHtml(docUrl);
  const action = pending ? 'invited you to' : 'gave you access to';
  const signInHint = pending
    ? `<p>You'll need to sign in with Google using this email address to access it.</p>`
    : '';
  return sendEmail({
    to,
    replyTo,
    subject: sanitizeHeader(`${inviter} shared "${title}" with you on Squire Docs`),
    html: `
      <h3>${safeInviter} shared a document with you</h3>
      <p><strong>${safeInviter}</strong> ${action} the document <strong>"${safeTitle}"</strong> on Squire Docs.</p>
      <p><a href="${safeUrl}">Open the document</a></p>
      ${signInHint}
    `,
  });
}

/** Invite a person who is NOT yet signed up to a shared document. */
const sendShareInvite = (opts) => sendShareEmail({ ...opts, pending: true });

/** Notify an existing user that a document has just been shared with them. */
const sendShareNotification = (opts) => sendShareEmail({ ...opts, pending: false });

/** Render the beta welcome email body. `firstName` is already escaped by the caller. */
function welcomeEmailHtml(firstName) {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #1a1a1a;">
      <p>Hi ${firstName},</p>
      <p>Welcome to Squire Docs! I'm Sam, one of the founders.</p>
      <p>We just opened our public beta, and I'm excited to have you try it out. Squire is built for engineering teams (and their coding agents) to write specs, design docs, and ADRs together, with two-way markdown sync to your repo and every edit attributed, human or AI.</p>
      <p>Right now we're looking for a small group of design partners to help shape the product. If that's you, here's what's in it for you:</p>
      <ul>
        <li><strong>$200/month in AI credits</strong>, instead of the standard $10, for as long as you're an active design partner.</li>
        <li>In exchange, we'd ask for <strong>25 minutes a month</strong> to hear how you're using Squire and what's not working.</li>
      </ul>
      <p>One thing on our roadmap I'd especially love your input on: <strong>teams and organization features</strong>. If you have thoughts on how your team should manage shared docs, permissions, or workspaces, that conversation would be a big help.</p>
      <p>If you're interested, just reply to this email and I'll grab time on your calendar.</p>
      <p>Thanks for giving Squire a try.</p>
      <p>Sam<br>Squire Docs</p>
    </div>
  `;
}

/**
 * Send the beta welcome email to a new sign-up. Admin-triggered (never automatic).
 * BCCs the admin (ADMIN_EMAIL) so Sam keeps a copy, and sets Reply-To to the admin
 * so the recipient's reply reaches a real inbox rather than the no-reply From.
 * Returns the sendEmail result object.
 */
function sendWelcomeEmail({ to, firstName }) {
  const name = escapeHtml((firstName && String(firstName).trim()) || 'there');
  return sendEmail({
    to,
    replyTo: ADMIN_EMAIL || undefined,
    bcc: ADMIN_EMAIL || undefined,
    subject: 'Welcome to Squire Docs',
    html: welcomeEmailHtml(name),
  });
}

module.exports = { sendEmail, notifyNewUser, notifyLogin, notifyCreditLimitReached, notifySupportRequest, sendShareInvite, sendShareNotification, sendWelcomeEmail };
