import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import { SmtpMailer } from '../server/mailer.js';

const received = [];
const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, _session, callback) {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'));
      callback();
    });
  },
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const { port } = server.server.address();
  const mailer = new SmtpMailer({ smtpUrl: `smtp://127.0.0.1:${port}`, from: 'Together Ledger <no-reply@example.test>', publicOrigin: 'https://together.example.test' });
  await mailer.sendVerification({ to: 'qa@example.test', token: 'qa-verify' });
  await mailer.sendInvitation({ to: 'qa@example.test', token: 'qa-invite' });
  await mailer.sendRecovery({ to: 'qa@example.test', token: 'qa-recovery' });
  assert.equal(received.length, 3);
  const decoded = received.map((message) => message.replace(/=\r\n/g, '').replace(/=3D/g, '='));
  assert.match(decoded[0], /\?verify=qa-verify/);
  assert.match(decoded[1], /\?invite=qa-invite/);
  assert.match(decoded[2], /\?recovery=qa-recovery/);
  console.log('✓ SMTP smoke check passed — verification, invitation, and recovery messages delivered locally.');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
