/**
 * Feature 058 (T030): server/image-storage/s3-driver.js with the AWS SDK client
 * mocked at `send`. Command shapes must be unchanged from s3-images.js.
 */
const { Readable } = require('stream');

const mockSend = jest.fn();
const mockClientOptions = [];
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation((opts) => {
      mockClientOptions.push(opts);
      return { send: mockSend };
    }),
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async () => 'https://signed.example/url'),
}));

const { _resetInstanceConfigForTests } = require('../instance-config');
const driver = require('../image-storage/s3-driver');

const VARS = ['S3_IMAGE_BUCKET', 'S3_IMAGE_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_ENDPOINT'];
const saved = {};
beforeAll(() => { for (const v of VARS) saved[v] = process.env[v]; });
afterAll(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  _resetInstanceConfigForTests();
});

function configure(vars) {
  for (const v of VARS) delete process.env[v];
  Object.assign(process.env, vars);
  _resetInstanceConfigForTests();
  mockSend.mockReset();
  mockClientOptions.length = 0;
}

const AWS = {
  S3_IMAGE_BUCKET: 'squire-images', S3_IMAGE_REGION: 'us-west-2',
  AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret',
};

test('isEnabled is false with no bucket; cspImageSources empty', () => {
  configure({});
  expect(driver.isEnabled()).toBe(false);
  expect(driver.cspImageSources()).toEqual([]);
});

test('virtual-hosted CSP origin without an endpoint, as today', () => {
  configure(AWS);
  expect(driver.isEnabled()).toBe(true);
  expect(driver.cspImageSources()).toEqual(['https://squire-images.s3.us-west-2.amazonaws.com']);
});

test('command shapes for put, get, copy, delete are unchanged', async () => {
  configure(AWS);
  mockSend.mockResolvedValue({ Body: Readable.from([Buffer.from('ab'), Buffer.from('c')]) });

  await driver.putObject({ key: 'k1', body: Buffer.from('x'), contentType: 'image/png' });
  expect(mockSend.mock.calls[0][0].input).toEqual({
    Bucket: 'squire-images', Key: 'k1', Body: Buffer.from('x'), ContentType: 'image/png',
    CacheControl: 'private, max-age=31536000, immutable',
  });

  expect(await driver.getObject('k1')).toEqual(Buffer.from('abc'));
  expect(mockSend.mock.calls[1][0].input).toEqual({ Bucket: 'squire-images', Key: 'k1' });

  await driver.copyObject('k1', 'k2');
  expect(mockSend.mock.calls[2][0].input).toEqual({ Bucket: 'squire-images', CopySource: 'squire-images/k1', Key: 'k2' });

  await driver.deleteObjects(['k1', 'k2']);
  expect(mockSend.mock.calls[3][0].input).toEqual({ Bucket: 'squire-images', Delete: { Objects: [{ Key: 'k1' }, { Key: 'k2' }] } });

  await driver.deleteObjects([]);
  expect(mockSend).toHaveBeenCalledTimes(4);

  expect(mockClientOptions[0]).toEqual({
    region: 'us-west-2', credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
  });
});

test('readObject returns the ContentType', async () => {
  configure(AWS);
  mockSend.mockResolvedValue({ Body: Readable.from([Buffer.from('img')]), ContentType: 'image/jpeg' });
  expect(await driver.readObject('k')).toEqual({ body: Buffer.from('img'), contentType: 'image/jpeg' });
});

test('S3_ENDPOINT: endpoint + path-style on the client, endpoint origin in the CSP', async () => {
  configure({ ...AWS, S3_ENDPOINT: 'http://minio:9000' });
  mockSend.mockResolvedValue({});
  await driver.putObject({ key: 'k', body: Buffer.from('x'), contentType: 'image/png' });
  expect(mockClientOptions[0]).toMatchObject({ endpoint: 'http://minio:9000', forcePathStyle: true });
  expect(driver.cspImageSources()).toEqual(['http://minio:9000']);
});

test('getSignedGetUrl presigns with the 1h TTL', async () => {
  configure(AWS);
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  expect(await driver.getSignedGetUrl('k')).toBe('https://signed.example/url');
  expect(getSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 3600 });
  expect(driver.kind).toBe('s3');
});
