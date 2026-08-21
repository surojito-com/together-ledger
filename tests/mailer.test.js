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
