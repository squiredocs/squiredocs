/**
 * Exception notifier unit tests
 * Tests rate limiting, email formatting, and graceful degradation.
 */

// Mock email.js before requiring the module under test
jest.mock('../email', () => ({
  sendEmail: jest.fn(),
}));

let sendEmail;
let notifyException;

/**
 * Reload the module to reset rate limiter state and pick up env var changes.
 * Uses jest.resetModules() so Jest's own module registry is also cleared.
 */
function loadModule() {
  jest.resetModules();
  sendEmail = require('../email').sendEmail;
  const mod = require('../exception-notifier');
  notifyException = mod.notifyException;
}

describe('exception-notifier', () => {
  describe('notifyException', () => {
    // Reload module before each test so rate limiter is fresh
    beforeEach(() => {
      process.env.ADMIN_EMAIL = 'admin@test.com';
      loadModule();
    });

    afterAll(() => {
      delete process.env.ADMIN_EMAIL;
    });

    test('sends email with error details', () => {
      const error = new Error('Something broke');
      notifyException(error, { source: 'test' });

      expect(sendEmail).toHaveBeenCalledTimes(1);
      const call = sendEmail.mock.calls[0][0];
      expect(call.to).toBe('admin@test.com');
      expect(call.subject).toContain('[Squire Docs]');
      expect(call.subject).toContain('Something broke');
      expect(call.html).toContain('Something broke');
      expect(call.html).toContain('test'); // source
    });

    test('includes error name in subject', () => {
      const error = new TypeError('bad type');
      notifyException(error, { source: 'api' });

      const call = sendEmail.mock.calls[0][0];
      expect(call.subject).toContain('TypeError');
    });

    test('truncates long error messages in subject', () => {
      const error = new Error('x'.repeat(200));
      notifyException(error, { source: 'api' });

      const call = sendEmail.mock.calls[0][0];
      expect(call.subject).toContain('...');
      expect(call.subject.length).toBeLessThan(200);
    });

    test('includes stack trace in email body', () => {
      const error = new Error('with stack');
      notifyException(error, { source: 'api' });

      const call = sendEmail.mock.calls[0][0];
      expect(call.html).toContain('exception-notifier.test.js');
    });

    test('includes request details when req is provided', () => {
      const error = new Error('request error');
      const req = {
        method: 'POST',
        originalUrl: '/api/docs',
        ip: '192.168.1.1',
        headers: {
          'user-agent': 'TestAgent/1.0',
          'content-type': 'application/json',
        },
        user: { userId: 'user-123', email: 'user@test.com' },
      };

      notifyException(error, { req, source: 'api' });

      const call = sendEmail.mock.calls[0][0];
      expect(call.html).toContain('POST');
      expect(call.html).toContain('/api/docs');
      expect(call.html).toContain('192.168.1.1');
      expect(call.html).toContain('TestAgent/1.0');
      expect(call.html).toContain('user-123');
      expect(call.html).toContain('user@test.com');
    });

    test('filters sensitive headers', () => {
      const error = new Error('sensitive');
      const req = {
        method: 'GET',
        originalUrl: '/api/test',
        ip: '127.0.0.1',
        headers: {
          'authorization': 'Bearer secret-token',
          'cookie': 'session=abc123',
          'x-api-key': 'sk-secret',
          'content-type': 'application/json',
        },
      };

      notifyException(error, { req, source: 'api' });

      const call = sendEmail.mock.calls[0][0];
      expect(call.html).not.toContain('secret-token');
      expect(call.html).not.toContain('abc123');
      expect(call.html).not.toContain('sk-secret');
      expect(call.html).toContain('application/json');
    });

    test('includes extra context when provided', () => {
      const error = new Error('ws error');
      notifyException(error, {
        source: 'websocket',
        extra: { connId: 42, docId: 'doc-abc' },
      });

      const call = sendEmail.mock.calls[0][0];
      expect(call.html).toContain('connId');
      expect(call.html).toContain('42');
      expect(call.html).toContain('docId');
      expect(call.html).toContain('doc-abc');
    });

    test('includes environment info', () => {
      const error = new Error('env test');
      notifyException(error, { source: 'api' });

      const call = sendEmail.mock.calls[0][0];
      expect(call.html).toContain(String(process.pid));
      expect(call.html).toContain('Host');
    });

    test('handles non-Error objects gracefully', () => {
      notifyException('string error', { source: 'api' });

      expect(sendEmail).toHaveBeenCalledTimes(1);
      const call = sendEmail.mock.calls[0][0];
      expect(call.html).toContain('string error');
    });

    test('handles null/undefined error gracefully', () => {
      expect(() => notifyException(null, { source: 'api' })).not.toThrow();
      expect(() => notifyException(undefined, { source: 'api' })).not.toThrow();
      expect(sendEmail).toHaveBeenCalledTimes(2);
    });

    test('escapes HTML in error messages', () => {
      const error = new Error('<script>alert("xss")</script>');
      notifyException(error, { source: 'api' });

      const call = sendEmail.mock.calls[0][0];
      expect(call.html).not.toContain('<script>');
      expect(call.html).toContain('&lt;script&gt;');
    });

    test('works without optional context fields', () => {
      const error = new Error('minimal');
      notifyException(error);

      expect(sendEmail).toHaveBeenCalledTimes(1);
      const call = sendEmail.mock.calls[0][0];
      expect(call.html).toContain('minimal');
      expect(call.html).toContain('unknown'); // default source
    });
  });

  describe('graceful degradation', () => {
    test('does not send email when ADMIN_EMAIL is not set', () => {
      delete process.env.ADMIN_EMAIL;
      loadModule();

      notifyException(new Error('no admin'));
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    beforeAll(() => {
      process.env.ADMIN_EMAIL = 'admin@test.com';
      loadModule();
    });

    afterAll(() => {
      delete process.env.ADMIN_EMAIL;
    });

    test('allows up to 10 emails then suppresses', () => {
      for (let i = 0; i < 10; i++) {
        notifyException(new Error(`error ${i}`), { source: 'test' });
      }
      expect(sendEmail).toHaveBeenCalledTimes(10);

      // 11th call should be suppressed
      sendEmail.mockClear();
      notifyException(new Error('over limit'), { source: 'test' });
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('sendEmail error handling', () => {
    beforeEach(() => {
      process.env.ADMIN_EMAIL = 'admin@test.com';
      loadModule();
    });

    afterAll(() => {
      delete process.env.ADMIN_EMAIL;
    });

    test('does not throw when sendEmail throws', () => {
      sendEmail.mockImplementationOnce(() => {
        throw new Error('SMTP failure');
      });

      expect(() => {
        notifyException(new Error('trigger failure'), { source: 'test' });
      }).not.toThrow();
    });
  });
});
