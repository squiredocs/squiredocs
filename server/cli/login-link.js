/**
 * `squire login-link --email E` (feature 059, FR-041): a sign-in link for an
 * existing account, found case-insensitively, in either mode.
 */
const { mintLink, buildLinkUrl } = require('../auth/signin-links');
const { findUserByEmail } = require('../auth/users');
const { msg } = require('./messages');

async function loginLink({ args = {}, pool, out, err }) {
  const email = typeof args.email === 'string' ? args.email.trim() : '';
  if (!email) {
    err.write(`${msg('loginLinkEmailRequired')}\n`);
    return 2;
  }
  const user = await findUserByEmail(pool, email);
  if (!user) {
    const any = await pool.query('SELECT 1 FROM users LIMIT 1');
    err.write(`${msg(any.rows.length ? 'loginLinkNoUser' : 'loginLinkNoUserUnclaimed', { email })}\n`);
    return 1;
  }
  const { token } = await mintLink(pool, { kind: 'signin', userId: user.id, source: 'cli' });
  err.write(`Open this link within 15 minutes to sign in as ${user.name} (${user.email}).\n`);
  out.write(`${buildLinkUrl(token)}\n`);
  return 0;
}

module.exports = { loginLink };
