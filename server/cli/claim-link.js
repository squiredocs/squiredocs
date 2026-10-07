/**
 * `squire claim-link [--name N] [--email E]` (feature 059, FR-032, FR-040,
 * contracts/squire-cli.md).
 *
 *   zero users            mint a `claim` link carrying the prefill
 *   owner resolvable      mint a `signin` link for the owner (flags ignored)
 *   owner not resolvable  exit 1, name `squire login-link --email`
 *
 * stdout carries only the bare URL line; everything else goes to stderr.
 */
const { mintLink, buildLinkUrl, EMAIL_RE } = require('../auth/signin-links');
const { resolveOwner } = require('../auth/instance-owner');
const { msg } = require('./messages');

/**
 * @param {{ args: { name?: string, email?: string }, pool: object,
 *   out: { write: Function }, err: { write: Function } }} ctx
 * @returns {Promise<number>} exit code
 */
async function claimLink({ args = {}, pool, out, err }) {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const email = typeof args.email === 'string' ? args.email.trim() : '';

  const owner = await resolveOwner(pool);
  if (owner.user) {
    const { token } = await mintLink(pool, { kind: 'signin', userId: owner.user.id, source: 'cli' });
    const flagged = args.name !== undefined || args.email !== undefined;
    err.write(
      `This instance already has an owner (${owner.user.name}, ${owner.user.email})` +
      (flagged ? '; --name and --email were ignored' : '') +
      '. The link signs in the owner within 15 minutes.\n'
    );
    out.write(`${buildLinkUrl(token)}\n`);
    return 0;
  }
  if (owner.reason !== 'no_users') {
    err.write(`${msg('ownerAmbiguous')}\n`);
    return 1;
  }
  // Validated only here, where it is used (059 review L4): on a claimed
  // instance the flags are ignored, so a bad value must not block the link.
  if (email && !EMAIL_RE.test(email)) {
    err.write(`${msg('badEmailFlag', { email })}\n`);
    return 2;
  }

  const { token } = await mintLink(pool, {
    kind: 'claim',
    prefillName: name || null,
    prefillEmail: email || null,
    source: 'cli',
  });
  err.write('Open this link within 15 minutes to create the owner account.\n');
  out.write(`${buildLinkUrl(token)}\n`);
  return 0;
}

module.exports = { claimLink };
