# Contract: Storage Interface and Boot Modules (058)

## `server/image-storage/index.js` (facade)

Every consumer of image bytes requires this module. No module other than the
facade may require a driver file (enforced by a `git grep` guard test).

```js
storage.kind                       // 'local' | 's3'
storage.isEnabled()                // boolean
storage.cspImageSources()          // string[] of origins for CSP img-src
await storage.putObject({ key, body, contentType })
await storage.getObject(key)       // Buffer
await storage.readObject(key)      // { body: Buffer, contentType: string|null }  (new)
await storage.getSignedGetUrl(key) // string; s3 only, local throws
await storage.copyObject(srcKey, dstKey)
await storage.deleteObjects(keys)  // no-op for [] or undefined
storage.GET_URL_TTL_SECONDS        // 3600
```

Errors: a missing object rejects with an error whose `code` is `'NoSuchKey'`
for both drivers (the S3 SDK already uses that name; the local driver maps
`ENOENT` to it), so callers map it to 404 without knowing the driver. An unsafe
key rejects with `code: 'InvalidKey'`.

## `server/boot/secrets.js`

```js
SECRET_NAMES // ['ACCESS_TOKEN_SECRET','REFRESH_TOKEN_SECRET','MCP_JWT_SECRET','API_KEY_ENCRYPTION_KEY']
resolveSecrets({ env, dataDir, generate = true, log = console })
// → { generated: string[], fromFile: string[], fromEnv: string[], path }
// mutates env; throws SecretsError (message names the path and the fix)
```

## `server/boot/migrate-lock.js`

```js
MIGRATE_LOCK_KEY // named constant; must differ from node-pg-migrate's 7241865325823964
runMigrationsWithLock({ env, log = console, connectTimeoutMs = 60000, runMigrate })
// → Promise<void>; rejects on connect timeout, migrate failure (with exit code)
```

## `server/boot/entrypoint.js` and `script/entrypoint.js`

```js
main({ env = process.env, serverModule = require.resolve('../index.js'), dotenvPath = '.env', log = console })
// order: dotenv → telemetry.start() → resolveInstanceConfig → resolveSecrets → (migrate) → require(serverModule)
```

`script/entrypoint.js` is `require('../server/boot/entrypoint').main().catch(fatal)`
where `fatal` prints `[Boot] <message>` and calls `process.exit(1)`.

## `server/instance-config.js`

```js
resolveInstanceConfig(env)   // pure; returns frozen config (data-model section 1) or throws ConfigError
getInstanceConfig()          // memoized resolve of process.env
_resetInstanceConfigForTests()
hostedOnly(req, res, next)   // next() when hosted, else next('route')
```

## `server/auth/middleware.js`

```js
requireAuthOrCookie(req, res, next) // new; header path identical to requireAuth, else accessToken cookie
```

## Image (Dockerfile)

- `ENV NODE_ENV=production SQUIRE_DATA_DIR=/data MIGRATE_ON_BOOT=true`
- `RUN mkdir -p /data && chown appuser:appgroup /data && chmod 0750 /data` before `USER appuser`
- `HEALTHCHECK --interval=30s --timeout=3s --start-period=90s --retries=3 CMD node -e "...get('http://localhost:3001/ready'...)"`
- `CMD ["node", "script/entrypoint.js"]` (`CMD`, not `ENTRYPOINT`, so the
  Kubernetes migrate Job's `command: ["npm"]` still replaces it)
