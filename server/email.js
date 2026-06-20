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
 */
async function sendEmail({ to, subject, html, replyTo }) {
  if (!FROM_EMAIL) {
    console.warn('SES_FROM_EMAIL not set — skipping email:', subject);
    return;
  }

  try {
    const message = { from: `Squire Docs <${FROM_EMAIL}>`, to, subject, html };
    if (replyTo) message.replyTo = sanitizeHeader(replyTo);
    await getTransporter().sendMail(message);
  } catch (err) {
    console.error('Failed to send email:', subject, err.message);
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

module.exports = { sendEmail, notifyNewUser, notifyLogin, notifyCreditLimitReached, notifySupportRequest };
