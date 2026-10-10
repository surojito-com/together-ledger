import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PASSWORD_CHANGED_TEXT, SmtpMailer } from '../server/mailer.js';

test('SMTP messages contain only the intended single-use application links', async () => {
  const messages = [];
  const transport = { sendMail: async (message) => { messages.push(message); return { accepted: [message.to] }; } };
  const mailer = new SmtpMailer({ transport, from: 'Together Ledger <no-reply@example.test>', accountOrigin: 'https://accounts.example.test' });

  await mailer.sendVerification({ to: 'alex@example.test', token: 'verify_token' });
  await mailer.sendInvitation({ to: 'alex@example.test', token: 'invite_token' });
  await mailer.sendRecovery({ to: 'alex@example.test', token: 'recovery_token' });

  assert.equal(messages.length, 3);
  assert.match(messages[0].text, /https:\/\/accounts\.example\.test\/#verify=verify_token/);
  assert.match(messages[1].text, /https:\/\/accounts\.example\.test\/invite#invite=invite_token/);
  assert.match(messages[2].text, /https:\/\/accounts\.example\.test\/#recovery=recovery_token/);
  assert.ok(messages.every((message) => message.from.includes('Together Ledger') && message.to === 'alex@example.test'));
});

test('each account email can stay with the allowed origin that requested it', async () => {
  const messages = [];
  const transport = { sendMail: async (message) => { messages.push(message); return { accepted: [message.to] }; } };
  const mailer = new SmtpMailer({ transport, from: 'Together Ledger <no-reply@example.test>', accountOrigin: 'https://fallback.example.test' });

  await mailer.sendVerification({ to: 'alex@example.test', token: 'public_verify', accountOrigin: 'https://together.example.test' });
  await mailer.sendInvitation({ to: 'alex@example.test', token: 'api_invite', accountOrigin: 'https://api.together.example.test' });
  await mailer.sendRecovery({ to: 'alex@example.test', token: 'public_recovery', accountOrigin: 'https://together.example.test' });

  assert.match(messages[0].text, /https:\/\/together\.example\.test\/#verify=public_verify/);
  assert.match(messages[1].text, /https:\/\/api\.together\.example\.test\/invite#invite=api_invite/);
  assert.match(messages[2].text, /https:\/\/together\.example\.test\/#recovery=public_recovery/);
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
  assert.match(message.text, /private place for two people/);
  assert.doesNotMatch(message.text, /private place for people/);
  assert.match(message.text, /https:\/\/accounts\.example\.test\/invite#invite=invite_token/);
  assert.match(message.html, /Open your invitation/);
  assert.match(message.html, /private place for two people/);
  // An invitation lasts 14 days (#347), so its link says so rather than calling itself short-lived.
  assert.match(message.text, /This link works once, for 14 days\./);
  assert.match(message.html, /This link works once, for 14 days\./);
  assert.doesNotMatch(`${message.text}${message.html}`, /short-lived/);
  await mailer.sendInvitation({ to: 'alex@example.test', token: 'invite_token', days: 1 });
  assert.match(messages[1].text, /This link works once, for 1 day\./);
  assert.match(message.html, /https:\/\/accounts\.example\.test\/invite#invite=invite_token/);
});

test('EMail-0020 verification provides a polished HTML message and accessible text alternative', async () => {
  const messages = [];
  const transport = { sendMail: async (message) => { messages.push(message); return { accepted: [message.to] }; } };
  const mailer = new SmtpMailer({ transport, from: 'Together Ledger <no-reply@example.test>', accountOrigin: 'https://accounts.example.test' });

  await mailer.sendVerification({ to: 'alex@example.test', token: 'verify_token' });

  const [message] = messages;
  assert.equal(message.subject, 'Verify your Together Ledger email');
  assert.match(message.text, /One small step, then you’re in\./);
  assert.match(message.text, /https:\/\/accounts\.example\.test\/#verify=verify_token/);
  assert.match(message.html, /Verify email address/);
  assert.match(message.html, /short-lived link works once/);
  assert.match(message.html, /https:\/\/accounts\.example\.test\/#verify=verify_token/);
});

test('EMail-0030 recovery provides a polished HTML message and accessible text alternative', async () => {
  const messages = [];
  const transport = { sendMail: async (message) => { messages.push(message); return { accepted: [message.to] }; } };
  const mailer = new SmtpMailer({ transport, from: 'Together Ledger <no-reply@example.test>', accountOrigin: 'https://accounts.example.test' });

  await mailer.sendRecovery({ to: 'alex@example.test', token: 'recovery_token' });

  const [message] = messages;
  assert.equal(message.subject, 'Reset your Together Ledger password');
  assert.match(message.text, /Choose a new password\./);
  assert.match(message.text, /short-lived link works once/);
  assert.match(message.text, /Your password stays as it is unless this link is used\./);
  assert.match(message.text, /https:\/\/accounts\.example\.test\/#recovery=recovery_token/);
  assert.match(message.html, /Choose a new password/);
  assert.match(message.html, /short-lived link works once/);
  assert.match(message.html, /If the button does not open, copy this link into your browser/);
  assert.match(message.html, /Your password stays as it is unless this link is used\./);
  assert.match(message.html, /href="https:\/\/accounts\.example\.test\/#recovery=recovery_token"/);
});

test('each account email carries both a text and an HTML part', async () => {
  const messages = [];
  const transport = { sendMail: async (message) => { messages.push(message); return { accepted: [message.to] }; } };
  const mailer = new SmtpMailer({ transport, from: 'Together Ledger <no-reply@example.test>', accountOrigin: 'https://accounts.example.test' });

  await mailer.sendInvitation({ to: 'alex@example.test', token: 'invite_token' });
  await mailer.sendVerification({ to: 'alex@example.test', token: 'verify_token' });
  await mailer.sendRecovery({ to: 'alex@example.test', token: 'recovery_token' });

  for (const message of messages) {
    assert.ok(message.text, `${message.subject} has no text part`);
    assert.ok(message.html, `${message.subject} has no HTML part`);
    assert.match(message.html, /Together Ledger<\/td>/, `${message.subject} is missing the shared header`);
    assert.match(message.html, />Together Ledger is a private shared journey workspace for two people to hold what happened and return to what matters\.<\/td>/, `${message.subject} is missing the shared footer`);
    assert.doesNotMatch(`${message.text}${message.html}`, /for people/, `${message.subject} still says "for people"`);
  }
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

// #261: the code rides after the #, which no browser sends to a server or puts in a Referer. In
// the query it reached the app's host in the address, and again in the Referer of the page's files.
test('every emailed link carries its code after the #, never in the query', async () => {
  const messages = [];
  const transport = { sendMail: async (message) => { messages.push(message); return { accepted: [message.to] }; } };
  const mailer = new SmtpMailer({ transport, from: 'Together Ledger <no-reply@example.test>', accountOrigin: 'https://accounts.example.test' });

  // Tokens are base64url, so they never need escaping; one with "+" and "=" shows that a code
  // that did would still come back whole.
  await mailer.sendVerification({ to: 'alex@example.test', token: 'verify_Tok-en' });
  await mailer.sendInvitation({ to: 'alex@example.test', token: 'invite+tok=en' });
  await mailer.sendRecovery({ to: 'alex@example.test', token: 'recovery_token' });

  const expected = [['verify', 'verify_Tok-en'], ['invite', 'invite+tok=en'], ['recovery', 'recovery_token']];
  for (const [index, [key, token]] of expected.entries()) {
    const message = messages[index];
    const links = [message.text, message.html].flatMap((part) => (part.match(/https?:\/\/[^\s"'<>]+/g) || []).map((link) => new URL(link.replace(/&amp;/g, '&'))));
    assert.ok(links.length >= 2, `the ${key} email carries its link in both parts`);
    for (const url of links) {
      assert.equal(url.search, '', `the ${key} link has a query: ${url.href}`);
      // An invitation has its own path, so the phone can claim it alone (#266); the others stay at /.
      assert.equal(url.pathname, key === 'invite' ? '/invite' : '/');
      assert.equal(new URLSearchParams(url.hash.slice(1)).get(key), token, `the ${key} link carries its code after the #`);
      assert.ok(!url.href.split('#')[0].includes(token), `the ${key} code is before the #`);
    }
  }
});

// #194: the notice that a password was changed while signed in. It is plain text with no link at
// all: nothing in it can sign anyone in or reset anything, and nothing from any journey is in it.
test('the password-changed notice is one plain message that carries no link, code, or journey content', async () => {
  const messages = [];
  const transport = { sendMail: async (message) => { messages.push(message); return { accepted: [message.to] }; } };
  const mailer = new SmtpMailer({
    transport,
    from: 'Together Ledger <no-reply@example.test>',
    recoveryFrom: 'Together Ledger - 030 Password Reset <account-recovery@example.test>',
    accountOrigin: 'https://accounts.example.test',
  });

  await mailer.sendPasswordChanged({ to: 'alex@example.test', token: 'never-sent', journey: 'Never sent either' });

  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.deepEqual(Object.keys(message).sort(), ['from', 'html', 'subject', 'text', 'to']);
  assert.equal(message.html, undefined, 'plain text only');
  assert.equal(message.to, 'alex@example.test');
  assert.equal(message.from, 'Together Ledger - 030 Password Reset <account-recovery@example.test>', 'from the password sender, as recovery is');
  assert.equal(message.subject, 'Your Together Ledger password was changed');
  assert.equal(message.text, PASSWORD_CHANGED_TEXT);
  assert.doesNotMatch(message.text, /https?:|www\.|#|accounts\.example\.test|never-sent|Never sent either/, 'no link, no code, nothing it was not given to say');
  assert.match(message.text, /choose “I forgot my password”/, 'what to do if it was not them: the words both sign-in screens use');
  assert.match(message.text, /ledger-support@together-ledger\.com/);
  assert.match(message.text, /Every device signed in to the account was signed out, except the one used to change it\./);
  const signIn = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const phone = await readFile(new URL('../apps/mobile/app/account.tsx', import.meta.url), 'utf8');
  assert.ok(signIn.includes('>I forgot my password<') && phone.includes('label="I forgot my password"'), 'the button the email names is the one both clients show');
});
