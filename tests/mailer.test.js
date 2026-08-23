import test from 'node:test';
import assert from 'node:assert/strict';
import { SmtpMailer } from '../server/mailer.js';

test('SMTP messages contain only the intended single-use application links', async () => {
  const messages = [];
  const transport = { sendMail: async (message) => { messages.push(message); return { accepted: [message.to] }; } };
  const mailer = new SmtpMailer({ transport, from: 'Together Ledger <no-reply@example.test>', accountOrigin: 'https://accounts.example.test' });

  await mailer.sendVerification({ to: 'alex@example.test', token: 'verify_token' });
  await mailer.sendInvitation({ to: 'alex@example.test', token: 'invite_token' });
  await mailer.sendRecovery({ to: 'alex@example.test', token: 'recovery_token' });

  assert.equal(messages.length, 3);
  assert.match(messages[0].text, /https:\/\/accounts\.example\.test\/\?verify=verify_token/);
  assert.match(messages[1].text, /https:\/\/accounts\.example\.test\/\?invite=invite_token/);
  assert.match(messages[2].text, /https:\/\/accounts\.example\.test\/\?recovery=recovery_token/);
  assert.ok(messages.every((message) => message.from.includes('Together Ledger') && message.to === 'alex@example.test'));
});

test('each account email can stay with the allowed origin that requested it', async () => {
  const messages = [];
  const transport = { sendMail: async (message) => { messages.push(message); return { accepted: [message.to] }; } };
  const mailer = new SmtpMailer({ transport, from: 'Together Ledger <no-reply@example.test>', accountOrigin: 'https://fallback.example.test' });

  await mailer.sendVerification({ to: 'alex@example.test', token: 'public_verify', accountOrigin: 'https://together.example.test' });
  await mailer.sendInvitation({ to: 'alex@example.test', token: 'api_invite', accountOrigin: 'https://api.together.example.test' });
  await mailer.sendRecovery({ to: 'alex@example.test', token: 'public_recovery', accountOrigin: 'https://together.example.test' });

  assert.match(messages[0].text, /https:\/\/together\.example\.test\/\?verify=public_verify/);
  assert.match(messages[1].text, /https:\/\/api\.together\.example\.test\/\?invite=api_invite/);
  assert.match(messages[2].text, /https:\/\/together\.example\.test\/\?recovery=public_recovery/);
  assert.ok(messages.every((message) => !message.text.includes('fallback.example.test')));
});

test('Email-0010 invitation provides a polished HTML message and accessible text alternative', async () => {
  const messages = [];
  const transport = { sendMail: async (message) => { messages.push(message); return { accepted: [message.to] }; } };
  const mailer = new SmtpMailer({ transport, from: 'Together Ledger <no-reply@example.test>', accountOrigin: 'https://accounts.example.test' });

  await mailer.sendInvitation({ to: 'alex@example.test', token: 'invite_token' });

  const [message] = messages;
  assert.equal(message.subject, 'You have been invited to a Together Ledger journey');
  assert.match(message.text, /You have been invited to a shared journey\./);
  assert.match(message.text, /https:\/\/accounts\.example\.test\/\?invite=invite_token/);
  assert.match(message.html, /Open your invitation/);
  assert.match(message.html, /short-lived link works once/);
  assert.match(message.html, /https:\/\/accounts\.example\.test\/\?invite=invite_token/);
});

test('EMail-0020 verification provides a polished HTML message and accessible text alternative', async () => {
  const messages = [];
  const transport = { sendMail: async (message) => { messages.push(message); return { accepted: [message.to] }; } };
  const mailer = new SmtpMailer({ transport, from: 'Together Ledger <no-reply@example.test>', accountOrigin: 'https://accounts.example.test' });

  await mailer.sendVerification({ to: 'alex@example.test', token: 'verify_token' });

  const [message] = messages;
  assert.equal(message.subject, 'Verify your Together Ledger email');
  assert.match(message.text, /One small step, then you’re in\./);
  assert.match(message.text, /https:\/\/accounts\.example\.test\/\?verify=verify_token/);
  assert.match(message.html, /Verify email address/);
  assert.match(message.html, /short-lived link works once/);
  assert.match(message.html, /https:\/\/accounts\.example\.test\/\?verify=verify_token/);
});

test('each account email uses its purpose-specific sender', async () => {
  const messages = [];
  const transport = { sendMail: async (message) => { messages.push(message); return { accepted: [message.to] }; } };
  const mailer = new SmtpMailer({
    transport,
    from: 'Together Ledger <no-reply@example.test>',
    invitationFrom: 'Together Ledger - 010 Journey Invite <journey-invitation@example.test>',
    verificationFrom: 'Together Ledger - 020 Email Verification <account-verification@example.test>',
    recoveryFrom: 'Together Ledger - 030 Password Reset <account-recovery@example.test>',
    accountOrigin: 'https://accounts.example.test',
  });

  await mailer.sendInvitation({ to: 'alex@example.test', token: 'invite_token' });
  await mailer.sendVerification({ to: 'alex@example.test', token: 'verify_token' });
  await mailer.sendRecovery({ to: 'alex@example.test', token: 'recovery_token' });

  assert.deepEqual(messages.map((message) => message.from), [
    'Together Ledger - 010 Journey Invite <journey-invitation@example.test>',
    'Together Ledger - 020 Email Verification <account-verification@example.test>',
    'Together Ledger - 030 Password Reset <account-recovery@example.test>',
  ]);
});
