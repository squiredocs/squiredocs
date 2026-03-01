/**
 * Email notifications via AWS SES SMTP
 * Fire-and-forget — never blocks HTTP responses, logs errors but never throws.
 * Gracefully skips if SES_FROM_EMAIL is not configured.
 */

const nodemailer = require('nodemailer');

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

/**
 * Send an email via SES SMTP. Never throws.
 */
async function sendEmail({ to, subject, html }) {
  if (!FROM_EMAIL) {
    console.warn('SES_FROM_EMAIL not set — skipping email:', subject);
    return;
  }

  try {
    await getTransporter().sendMail({ from: `HeroDocs <${FROM_EMAIL}>`, to, subject, html });
  } catch (err) {
    console.error('Failed to send email:', subject, err.message);
  }
}

/**
 * Notify admin of a new user registration
 */
function notifyNewUser({ email, name }) {
  if (!ADMIN_EMAIL) return;
  sendEmail({
    to: ADMIN_EMAIL,
    subject: `New user registered: ${email}`,
    html: `
      <h3>New user registration</h3>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Name:</strong> ${name || '(not provided)'}</p>
    `,
  });
}

module.exports = { sendEmail, notifyNewUser };
