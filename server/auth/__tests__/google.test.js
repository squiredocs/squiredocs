/**
 * Google OAuth utility tests
 */
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

const { fetchUserInfo } = require('../google');

describe('fetchUserInfo', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('returns the userinfo payload on success', async () => {
    const payload = { picture: 'https://lh3.googleusercontent.com/a/abc', name: 'Phoebe Saru' };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const info = await fetchUserInfo('access-token-123');

    expect(info).toEqual(payload);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://openidconnect.googleapis.com/v1/userinfo',
      { headers: { Authorization: 'Bearer access-token-123' } }
    );
  });

  test('returns {} without calling fetch when no access token is provided', async () => {
    global.fetch = jest.fn();

    const info = await fetchUserInfo(undefined);

    expect(info).toEqual({});
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns {} on a non-ok response', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });

    const info = await fetchUserInfo('bad-token');

    expect(info).toEqual({});
  });

  test('returns {} when fetch throws', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

    const info = await fetchUserInfo('access-token-123');

    expect(info).toEqual({});
  });
});
