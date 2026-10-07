#!/usr/bin/env node
/**
 * Container entrypoint (feature 058): secrets, migrations, then the server.
 * The logic lives in server/boot/entrypoint.js so Jest can test it.
 */
require('../server/boot/entrypoint')
  .main()
  .catch((err) => {
    console.error(`[Boot] ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
