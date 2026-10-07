/**
 * Feature 058 (T060, FR-020/021): the real server/email.js builds its SMTP
 * transport from the instance config. nodemailer.createTransport is spied; no
 * mail leaves the process.
 */
const nodemailer = require('nodemailer');
const { _resetInstanceConfigForTests } = require('../instance-config');
const { sendEmail } = require('../email');

const NAMES = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'SES_SMTP_HOST', 'SES_SMTP_USER', 'SES_SMTP_PASS', 'SES_FROM_EMAIL'];
const SAVED = {};
let sendMail;
let createTransport;

beforeAll(() => { for (const n of NAMES) SAVED[n] = process.env[n]; });
afterAll(() => {
  for (const n of NAMES) {
    if (SAVED[n] === undefined) delete process.env[n];
    else process.env[n] = SAVED[n];
  }
  _resetInstanceConfigForTests();
});

beforeEach(() => {
  sendMail = jest.fn(async () => ({ messageId: 'mid-1' }));
  createTransport = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });
});
afterEach(() => jest.restoreAllMocks());

function configure(vars) {
  for (const n of NAMES) delete process.env[n];
  Object.assign(process.env, vars);
  _resetInstanceConfigForTests();
}

const MSG = { to: 'someone@example.com', subject: 'Hi', html: '<p>hi</p>' };

test('generic variables produce exactly that transport', async () => {
  configure({
    SMTP_HOST: 'mail.example.com', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'docs@example.com',
  });
  const res = await sendEmail(MSG);
  expect(res).toEqual({ ok: true, messageId: 'mid-1' });
  expect(createTransport).toHaveBeenCalledWith({
    host: 'mail.example.com', port: 587, secure: false, auth: { user: 'u', pass: 'p' },
  });
  expect(sendMail.mock.calls[0][0].from).toBe('Squire Docs <docs@example.com>');
});

test('SES-only (the hosted config) produces the pre-058 transport', async () => {
  configure({ SES_SMTP_USER: 'AKIA', SES_SMTP_PASS: 'pw', SES_FROM_EMAIL: 'noreply@squiredocs.com' });
  await sendEmail(MSG);
  expect(createTransport).toHaveBeenCalledWith({
    host: 'email-smtp.us-west-2.amazonaws.com', port: 465, secure: true, auth: { user: 'AKIA', pass: 'pw' },
  });
  expect(sendMail.mock.calls[0][0].from).toBe('Squire Docs <noreply@squiredocs.com>');
});

test('SMTP_SECURE overrides the port rule; no credentials means no auth block', async () => {
  configure({ SMTP_HOST: 'relay.local', SMTP_PORT: '25', SMTP_SECURE: 'false', SMTP_FROM: 'a@b.c' });
  await sendEmail(MSG);
  expect(createTransport).toHaveBeenCalledWith({ host: 'relay.local', port: 25, secure: false });
});

test('no sender: skipped, nothing logged at warn level, no transport', async () => {
  configure({});
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const res = await sendEmail(MSG);
  expect(res).toEqual({ ok: false, skipped: true });
  expect(warn).not.toHaveBeenCalled();
  expect(createTransport).not.toHaveBeenCalled();
});

test('a sender but no host: skipped', async () => {
  configure({ SMTP_FROM: 'a@b.c' });
  const res = await sendEmail(MSG);
  expect(res).toEqual({ ok: false, skipped: true });
  expect(createTransport).not.toHaveBeenCalled();
});
