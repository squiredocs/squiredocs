/**
 * Every failure message the `squire` CLI prints (feature 059, FR-044,
 * SC-008, contracts/squire-cli.md). Each one ends with a concrete next action:
 * a command to run or a setting to change. messages.test.js triggers every
 * entry through the command functions and checks its `next` text appears.
 *
 * Each entry: { text(args) -> string, next: string } where `next` is the
 * command or setting name the text must contain.
 */

const CLAIM = 'docker compose exec app squire claim-link';

const MESSAGES = {
  dbUnreachable: {
    next: 'docker compose ps',
    text: ({ host, port, name }) =>
      `Cannot connect to the database (DB_HOST=${host}, DB_PORT=${port}, DB_NAME=${name}). ` +
      'Check that the postgres container is healthy: docker compose ps',
  },
  badEmailFlag: {
    next: '--email',
    text: ({ email }) =>
      `--email ${JSON.stringify(email)} is not a valid email address. Pass an address like --email you@example.com`,
  },
  ownerAmbiguous: {
    next: 'squire login-link --email',
    text: () =>
      'Could not tell which account is the owner (no recorded owner and not exactly one administrator). ' +
      'Run: squire login-link --email <address>',
  },
  loginLinkNoUser: {
    next: 'squire login-link --email',
    text: ({ email }) =>
      `No account has the email ${email}. Check the address, or list accounts on the Admin page, then run: squire login-link --email <address>`,
  },
  loginLinkNoUserUnclaimed: {
    next: 'squire claim-link',
    text: ({ email }) =>
      `No account has the email ${email}. This instance has no owner yet. Run: squire claim-link`,
  },
  loginLinkEmailRequired: {
    next: '--email',
    text: () => 'Name the account to sign in: squire login-link --email you@example.com',
  },
  tokenNameRequired: {
    next: '--name',
    text: () => 'Name the token after the agent that will use it: squire token create --name "Claude Code"',
  },
  tokenTeamNeedsEmail: {
    next: '--email',
    text: () => 'In team mode, name the account: squire token create --name N --email you@example.com',
  },
  tokenNoOwner: {
    next: 'squire claim-link',
    text: () =>
      `This instance has no owner yet, so there is no account to create a token for. Claim it first: ${CLAIM}`,
  },
  tokenOwnerAmbiguous: {
    next: '--email',
    text: () =>
      'Could not tell which account is the owner (no recorded owner and not exactly one administrator). ' +
      'Name the account: squire token create --name N --email you@example.com',
  },
  tokenUnknownEmail: {
    next: 'squire login-link --email',
    text: ({ email }) =>
      `No account has the email ${email}. Check the address (squire login-link --email <address> tells you whether it exists) and pass it with --email.`,
  },
  tokenBadScopes: {
    next: '--scopes',
    text: ({ scopes }) =>
      `--scopes ${JSON.stringify(scopes)} is not valid. Use a comma list of documents:read and documents:write, for example --scopes documents:read`,
  },
  tokenBadExpiry: {
    next: '--expires-in',
    text: ({ value }) =>
      `--expires-in ${JSON.stringify(value)} is not valid. Use <n>d or <n>h between 1h and 365d, for example --expires-in 30d`,
  },
  tokenFileExists: {
    next: '--out',
    text: ({ path }) =>
      `${path} already exists. Choose another --out path, or delete the file and revoke the old token in Settings.`,
  },
  tokenFileError: {
    next: '--out',
    text: ({ path, reason }) =>
      `Cannot write ${path} (${reason}). Choose a writable location with --out, or check the data volume's permissions.`,
  },
  tokenMintFailed: {
    next: 'Settings',
    text: ({ reason }) =>
      `Could not create the token: ${reason}. Revoke unused tokens in Settings, then run the command again.`,
  },
  configError: {
    next: '.env',
    text: ({ message }) => `${message} Fix the value in .env, then run: docker compose up -d`,
  },
  doctorMigrations: {
    next: 'docker compose restart app',
    text: ({ pending }) =>
      `${pending} migration${pending === 1 ? '' : 's'} pending. Restart the app container to run them: docker compose restart app`,
  },
  doctorServer: {
    next: 'docker compose logs app',
    text: ({ url, reason }) =>
      `The server is not ready at ${url} (${reason}). Check its log for the cause: docker compose logs app`,
  },
  doctorNoProvider: {
    next: 'GOOGLE_CLIENT_ID',
    text: () =>
      'SQUIRE_MODE=team needs at least one sign-in provider. Set GOOGLE_CLIENT_ID and ' +
      'GOOGLE_CLIENT_SECRET, or use SQUIRE_MODE=local.',
  },
  doctorAppUrl: {
    next: 'APP_URL',
    text: ({ value }) =>
      `APP_URL ${value} is neither localhost nor https. Put a TLS proxy in front and set an https APP_URL.`,
  },
  unknownCommand: {
    next: 'squire --help',
    text: ({ command }) => `Unknown command ${JSON.stringify(command)}. Run: squire --help`,
  },
  usage: {
    next: 'squire --help',
    text: ({ reason }) => `${reason} Run: squire --help`,
  },
};

/** Render a message by key. */
function msg(key, args = {}) {
  const m = MESSAGES[key];
  if (!m) throw new Error(`unknown CLI message ${key}`);
  return m.text(args);
}

module.exports = { MESSAGES, msg, CLAIM };
