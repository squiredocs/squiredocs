/**
 * Feature 058 (T004): the real resolveInstanceConfig, driven with plain env
 * objects. Contract: specs/058-self-host-config/contracts/environment.md.
 */
const {
  resolveInstanceConfig,
  ConfigError,
  hostedOnly,
  _resetInstanceConfigForTests,
} = require('../instance-config');

const r = (env) => resolveInstanceConfig({ ...env });

describe('APP_URL chain (RBD-058-18)', () => {
  test('explicit APP_URL wins', () => {
    const c = r({ APP_URL: 'https://docs.example.com', CLIENT_URL: 'https://other.example.com' });
    expect(c.appUrl).toBe('https://docs.example.com');
    expect(c.appUrlSource).toBe('APP_URL');
  });

  test('falls back to CLIENT_URL', () => {
    const c = r({ CLIENT_URL: 'https://squiredocs.com' });
    expect(c.appUrl).toBe('https://squiredocs.com');
    expect(c.appUrlSource).toBe('CLIENT_URL');
  });

  test('defaults to localhost with PORT, and 3001 without', () => {
    expect(r({ PORT: '3910' }).appUrl).toBe('http://localhost:3910');
    const c = r({});
    expect(c.appUrl).toBe('http://localhost:3001');
    expect(c.appUrlSource).toBe('default');
  });

  test('SQUIRE_PORT is never consulted', () => {
    expect(r({ SQUIRE_PORT: '3910' }).appUrl).toBe('http://localhost:3001');
  });

  test('path and trailing slash are dropped', () => {
    expect(r({ APP_URL: 'https://docs.example.com/' }).appUrl).toBe('https://docs.example.com');
    expect(r({ APP_URL: 'http://localhost:3910/some/path?q=1' }).appUrl).toBe('http://localhost:3910');
  });

  test('invalid APP_URL names APP_URL', () => {
    expect(() => r({ APP_URL: 'docs.example.com' })).toThrow(ConfigError);
    expect(() => r({ APP_URL: 'docs.example.com' })).toThrow(/APP_URL/);
    expect(() => r({ APP_URL: 'ftp://docs.example.com' })).toThrow(/APP_URL/);
  });

  test('invalid CLIENT_URL as the source names CLIENT_URL', () => {
    expect(() => r({ CLIENT_URL: 'not a url' })).toThrow(/CLIENT_URL/);
  });
});

describe('derived URLs', () => {
  test('defaults follow APP_URL', () => {
    const c = r({ APP_URL: 'http://localhost:3910' });
    expect(c.clientUrl).toBe('http://localhost:3910');
    expect(c.googleRedirectUri).toBe('http://localhost:3910/auth/google/callback');
    expect(c.publicOrigin).toBe('http://localhost:3910');
  });

  test('explicit values win, CLIENT_URL verbatim', () => {
    const c = r({
      APP_URL: 'https://squiredocs.com',
      CLIENT_URL: 'https://squiredocs.com/',
      GOOGLE_REDIRECT_URI: 'https://squiredocs.com/auth/google/callback2',
      PUBLIC_ORIGIN: 'https://public.example.com',
    });
    expect(c.clientUrl).toBe('https://squiredocs.com/');
    expect(c.googleRedirectUri).toBe('https://squiredocs.com/auth/google/callback2');
    expect(c.publicOrigin).toBe('https://public.example.com');
  });
});

describe('cookieSecure and insecureRemoteHttp', () => {
  test('cookieSecure follows the scheme', () => {
    expect(r({ APP_URL: 'http://localhost:3910' }).cookieSecure).toBe(false);
    expect(r({ APP_URL: 'https://docs.example.com' }).cookieSecure).toBe(true);
    expect(r({ APP_URL: 'http://localhost:3910', NODE_ENV: 'production' }).cookieSecure).toBe(false);
  });

  test.each([
    ['http://192.168.1.5:3910', true],
    ['http://docs.lan', true],
    ['http://localhost:3910', false],
    ['http://127.0.0.1:3910', false],
    ['http://[::1]:3910', false],
    ['https://docs.example.com', false],
  ])('production %s -> %s', (url, expected) => {
    expect(r({ APP_URL: url, NODE_ENV: 'production' }).insecureRemoteHttp).toBe(expected);
  });

  test('never flagged outside production', () => {
    expect(r({ APP_URL: 'http://192.168.1.5', NODE_ENV: 'development' }).insecureRemoteHttp).toBe(false);
  });
});

describe('SQUIRE_HOSTED', () => {
  test.each([
    ['true', true, null],
    ['TRUE', true, null],
    ['false', false, null],
    ['FALSE', false, null],
    [undefined, false, null],
    ['1', false, '1'],
    ['yes', false, 'yes'],
  ])('%s -> hosted %s', (value, hosted, invalid) => {
    const env = value === undefined ? {} : { SQUIRE_HOSTED: value };
    const c = r(env);
    expect(c.hosted).toBe(hosted);
    expect(c.hostedInvalidValue).toBe(invalid);
  });
});

describe('STORAGE_DRIVER', () => {
  test('auto-detects s3 when a bucket is set, local otherwise', () => {
    expect(r({}).storageDriver).toBe('local');
    expect(r({ S3_IMAGE_BUCKET: 'b' }).storageDriver).toBe('s3');
  });

  test('explicit values win', () => {
    expect(r({ STORAGE_DRIVER: 'local', S3_IMAGE_BUCKET: 'b' }).storageDriver).toBe('local');
    expect(r({ STORAGE_DRIVER: 's3' }).storageDriver).toBe('s3');
  });

  test('unknown value lists the accepted values', () => {
    expect(() => r({ STORAGE_DRIVER: 'gcs' })).toThrow('STORAGE_DRIVER must be one of: local, s3');
  });
});

describe('MIGRATE_ON_BOOT, SQUIRE_DATA_DIR, S3_ENDPOINT', () => {
  test('MIGRATE_ON_BOOT defaults to true; accepts true/false', () => {
    expect(r({}).migrateOnBoot).toBe(true);
    expect(r({ MIGRATE_ON_BOOT: 'False' }).migrateOnBoot).toBe(false);
    expect(r({ MIGRATE_ON_BOOT: 'TRUE' }).migrateOnBoot).toBe(true);
  });

  test('invalid MIGRATE_ON_BOOT throws naming it', () => {
    expect(() => r({ MIGRATE_ON_BOOT: 'yes' })).toThrow(/MIGRATE_ON_BOOT/);
  });

  test('SQUIRE_DATA_DIR default and relative error', () => {
    expect(r({}).dataDir).toBe('/data');
    expect(r({ SQUIRE_DATA_DIR: '/srv/squire' }).dataDir).toBe('/srv/squire');
    expect(() => r({ SQUIRE_DATA_DIR: 'data' })).toThrow(/SQUIRE_DATA_DIR/);
  });

  test('S3_ENDPOINT must be an absolute http(s) URL', () => {
    expect(r({ S3_ENDPOINT: 'http://minio:9000/' }).s3.endpoint).toBe('http://minio:9000');
    expect(() => r({ S3_ENDPOINT: 'minio:9000' })).toThrow(/S3_ENDPOINT/);
  });

  test('s3 settings carry the existing defaults', () => {
    expect(r({}).s3).toEqual({ bucket: '', region: 'us-east-1', accessKeyId: '', secretAccessKey: '', endpoint: undefined });
  });
});

describe('SMTP (research R12)', () => {
  test('generic only', () => {
    const { smtp } = r({ SMTP_HOST: 'mail.example.com', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'a@example.com' });
    expect(smtp).toEqual({
      host: 'mail.example.com', port: 587, secure: false, user: 'u', pass: 'p', from: 'a@example.com', viaSesAliases: false,
    });
  });

  test('SES only with no host gives the SES default host, 465, implicit TLS', () => {
    const { smtp } = r({ SES_SMTP_USER: 'u', SES_SMTP_PASS: 'p', SES_FROM_EMAIL: 'noreply@squiredocs.com' });
    expect(smtp).toEqual({
      host: 'email-smtp.us-west-2.amazonaws.com', port: 465, secure: true, user: 'u', pass: 'p',
      from: 'noreply@squiredocs.com', viaSesAliases: true,
    });
  });

  test('both set: generic wins', () => {
    const { smtp } = r({
      SES_SMTP_HOST: 'ses.example', SES_SMTP_USER: 'su', SES_SMTP_PASS: 'sp', SES_FROM_EMAIL: 's@x',
      SMTP_HOST: 'mail.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'g@x',
    });
    expect(smtp.host).toBe('mail.example.com');
    expect(smtp.user).toBe('u');
    expect(smtp.pass).toBe('p');
    expect(smtp.from).toBe('g@x');
    expect(smtp.viaSesAliases).toBe(false);
  });

  test('generic config with no host does not get the SES default', () => {
    expect(r({ SMTP_FROM: 'a@x' }).smtp.host).toBeUndefined();
  });

  test('SMTP_PORT=587 gives secure false; SMTP_SECURE overrides', () => {
    expect(r({ SMTP_HOST: 'h', SMTP_PORT: '587' }).smtp.secure).toBe(false);
    expect(r({ SMTP_HOST: 'h', SMTP_PORT: '587', SMTP_SECURE: 'true' }).smtp.secure).toBe(true);
    expect(r({ SMTP_HOST: 'h', SMTP_SECURE: 'false' }).smtp.secure).toBe(false);
  });

  test('invalid SMTP_PORT throws naming it', () => {
    expect(() => r({ SMTP_PORT: '0' })).toThrow(/SMTP_PORT/);
    expect(() => r({ SMTP_PORT: 'abc' })).toThrow(/SMTP_PORT/);
    expect(() => r({ SMTP_PORT: '70000' })).toThrow(/SMTP_PORT/);
  });

  test('no sender', () => {
    expect(r({}).smtp.from).toBeUndefined();
  });
});

describe('frozen result', () => {
  test('cannot be mutated', () => {
    const c = r({});
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.smtp)).toBe(true);
  });
});

describe('hostedOnly', () => {
  const saved = process.env.SQUIRE_HOSTED;
  afterEach(() => {
    if (saved === undefined) delete process.env.SQUIRE_HOSTED;
    else process.env.SQUIRE_HOSTED = saved;
    _resetInstanceConfigForTests();
  });

  test('next() when hosted', () => {
    process.env.SQUIRE_HOSTED = 'true';
    _resetInstanceConfigForTests();
    const next = jest.fn();
    hostedOnly({}, {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  test("next('route') when not hosted", () => {
    delete process.env.SQUIRE_HOSTED;
    _resetInstanceConfigForTests();
    const next = jest.fn();
    hostedOnly({}, {}, next);
    expect(next).toHaveBeenCalledWith('route');
  });
});
