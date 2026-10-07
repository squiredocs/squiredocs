/**
 * Feature 058 (T037, RBD-058-20): requireAuthOrCookie. extractUser is mocked
 * so each credential path is driven precisely.
 */
const mockExtractUser = jest.fn();
jest.mock('../permissions', () => ({ extractUser: (...args) => mockExtractUser(...args) }));

const { requireAuthOrCookie } = require('../auth/middleware');

function run(partial) {
  const req = { method: 'GET', headers: {}, ...partial };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
  const next = jest.fn();
  return requireAuthOrCookie(req, res, next).then(() => ({ res, next, req }));
}

beforeEach(() => mockExtractUser.mockReset());

test('Authorization header takes the requireAuth path', async () => {
  mockExtractUser.mockResolvedValue({ userId: 'u1' });
  const req = { headers: { authorization: 'Bearer abc' }, cookies: { accessToken: 'cookie-token' } };
  const { res, next } = await run(req);
  expect(mockExtractUser).toHaveBeenCalledWith({ authHeader: 'Bearer abc' });
  expect(next).toHaveBeenCalled();
  expect(res.statusCode).toBeNull();
});

test('a bad header is 401 and never falls back to the cookie', async () => {
  mockExtractUser.mockResolvedValue(null);
  const { res, next } = await run({ headers: { authorization: 'Bearer bad' }, cookies: { accessToken: 'good' } });
  expect(res.statusCode).toBe(401);
  expect(res.body).toEqual({ error: 'Invalid or expired token' });
  expect(mockExtractUser).toHaveBeenCalledTimes(1);
  expect(next).not.toHaveBeenCalled();
});

test('the accessToken cookie authenticates when there is no header', async () => {
  mockExtractUser.mockResolvedValue({ userId: 'u2' });
  const { res, next, req } = await run({ cookies: { accessToken: 'cookie-token' } });
  expect(mockExtractUser).toHaveBeenCalledWith({ queryToken: 'cookie-token' });
  expect(next).toHaveBeenCalled();
  expect(req.user).toEqual({ userId: 'u2' });
  expect(res.statusCode).toBeNull();
});

test('the cookie is read from the raw header when cookie-parser did not run', async () => {
  mockExtractUser.mockResolvedValue({ userId: 'u3' });
  const { next } = await run({ headers: { cookie: 'a=1; accessToken=raw-token; b=2' } });
  expect(mockExtractUser).toHaveBeenCalledWith({ queryToken: 'raw-token' });
  expect(next).toHaveBeenCalled();
});

test('neither header nor cookie is 401', async () => {
  const { res, next } = await run({});
  expect(res.statusCode).toBe(401);
  expect(res.body).toEqual({ error: 'No authorization header' });
  expect(mockExtractUser).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});

test('an invalid cookie is 401', async () => {
  mockExtractUser.mockResolvedValue(null);
  const { res, next } = await run({ cookies: { accessToken: 'expired' } });
  expect(res.statusCode).toBe(401);
  expect(res.body).toEqual({ error: 'Invalid or expired token' });
  expect(next).not.toHaveBeenCalled();
});

test('a scoped token without documents:read is 403 on either path', async () => {
  mockExtractUser.mockResolvedValue({ userId: 'u4', scopes: ['documents:write'] });
  const viaCookie = await run({ cookies: { accessToken: 'scoped' } });
  expect(viaCookie.res.statusCode).toBe(403);
  expect(viaCookie.res.body.code).toBe('INSUFFICIENT_SCOPE');
  const viaHeader = await run({ headers: { authorization: 'Bearer scoped' } });
  expect(viaHeader.res.statusCode).toBe(403);
});
