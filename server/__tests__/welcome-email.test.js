/**
 * Tests for sendWelcomeEmail in server/email.js — verifies the message contract
 * (recipient, subject, BCC to the admin, Reply-To, first-name interpolation)
 * by mocking the nodemailer transport so no SMTP call is made.
 */
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-message-id' });

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

describe('sendWelcomeEmail', () => {
  let sendWelcomeEmail;

  beforeAll(() => {
    process.env.SES_FROM_EMAIL = 'no-reply@squiredocs.com';
    process.env.ADMIN_EMAIL = 'admin@example.com';
    jest.resetModules();
    ({ sendWelcomeEmail } = require('../email'));
  });

  beforeEach(() => mockSendMail.mockClear());

  test('sends to the user, BCCs the admin, and interpolates the first name', async () => {
    const result = await sendWelcomeEmail({ to: 'newuser@example.com', firstName: 'Ada' });

    expect(result.ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    const msg = mockSendMail.mock.calls[0][0];
    expect(msg.to).toBe('newuser@example.com');
    expect(msg.bcc).toBe('admin@example.com');
    expect(msg.replyTo).toBe('admin@example.com');
    expect(msg.subject).toBe('Welcome to Squire Docs');
    expect(msg.html).toContain('Hi Ada,');
    expect(msg.html).toContain('$200/month in AI credits');
  });

  test('falls back to "there" when no first name is provided', async () => {
    await sendWelcomeEmail({ to: 'newuser@example.com', firstName: '' });
    expect(mockSendMail.mock.calls[0][0].html).toContain('Hi there,');
  });

  test('escapes HTML in the first name', async () => {
    await sendWelcomeEmail({ to: 'newuser@example.com', firstName: '<script>' });
    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Hi &lt;script&gt;,');
    expect(html).not.toContain('Hi <script>,');
  });
});
