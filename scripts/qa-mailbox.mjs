import { createServer } from 'node:http';
import { SMTPServer } from 'smtp-server';

const smtpPort = Number(process.env.QA_SMTP_PORT) || 2525;
const httpPort = Number(process.env.QA_MAILBOX_PORT) || 8025;
const messages = [];

const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, _session, callback) {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const decoded = raw.replace(/=\r\n/g, '').replace(/=3D/g, '=');
      messages.push({
        receivedAt: new Date().toISOString(),
        subject: decoded.match(/^Subject: (.+)$/m)?.[1]?.trim() || '',
        to: decoded.match(/^To: (.+)$/m)?.[1]?.trim() || '',
        links: decoded.match(/https?:\/\/[^\s<>]+/g) || [],
      });
      callback();
    });
  },
});

const mailbox = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'DELETE') {
    messages.length = 0;
    response.writeHead(204).end();
    return;
  }
  response.end(JSON.stringify({ messages }));
});

await Promise.all([
  new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(smtpPort, '127.0.0.1', resolve); }),
  new Promise((resolve, reject) => { mailbox.once('error', reject); mailbox.listen(httpPort, '127.0.0.1', resolve); }),
]);
console.log(`QA mailbox ready: SMTP ${smtpPort}, messages http://127.0.0.1:${httpPort}/`);

async function shutdown() {
  await Promise.all([
    new Promise((resolve) => smtp.close(resolve)),
    new Promise((resolve) => mailbox.close(resolve)),
  ]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
