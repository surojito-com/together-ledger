export class MemoryMailer {
  constructor() {
    this.messages = [];
  }

  async sendInvitation(message) {
    this.messages.push({ type: 'invitation', ...message });
  }

  async sendRecovery(message) {
    this.messages.push({ type: 'recovery', ...message });
  }

  async sendVerification(message) {
    this.messages.push({ type: 'verification', ...message });
  }
}

export class ConsoleBlockedMailer {
  async sendInvitation() {
    throw new Error('Production invitation delivery is not configured.');
  }

  async sendRecovery() {
    throw new Error('Production recovery delivery is not configured.');
  }

  async sendVerification() {
    throw new Error('Production verification delivery is not configured.');
  }
}

export class SmtpMailer {
  constructor({ smtpUrl, from, invitationFrom = from, verificationFrom = from, recoveryFrom = from, accountOrigin, transport }) {
    this.transport = transport || nodemailer.createTransport(smtpUrl);
    this.from = from;
    this.invitationFrom = invitationFrom;
    this.verificationFrom = verificationFrom;
    this.recoveryFrom = recoveryFrom;
    this.accountOrigin = accountOrigin;
  }

  send({ from = this.from, to, subject, text, html }) {
    return this.transport.sendMail({ from, to, subject, text, html });
  }

  sendInvitation({ to, token, accountOrigin = this.accountOrigin }) {
    const invitationUrl = actionUrl(accountOrigin, 'invite', token);
    return this.send({
      from: this.invitationFrom,
      to,
      subject: 'You have been invited to a Together Ledger journey',
      text: email0010Text(invitationUrl),
      html: email0010Invitation(invitationUrl),
    });
  }

  sendRecovery({ to, token, accountOrigin = this.accountOrigin }) {
    const recoveryUrl = actionUrl(accountOrigin, 'recovery', token);
    return this.send({
      from: this.recoveryFrom,
      to,
      subject: 'Reset your Together Ledger password',
      text: `Reset your password: ${recoveryUrl}\n\nThis short-lived link works once. If you did not request it, ignore this message.`,
    });
  }

  sendVerification({ to, token, accountOrigin = this.accountOrigin }) {
    const verificationUrl = actionUrl(accountOrigin, 'verify', token);
    return this.send({
      from: this.verificationFrom,
      to,
      subject: 'Verify your Together Ledger email',
      text: email0020Text(verificationUrl),
      html: email0020Verification(verificationUrl),
    });
  }
}

function actionUrl(accountOrigin, action, token) {
  const url = new URL(accountOrigin);
  url.searchParams.set(action, token);
  return url.toString();
}

function email0010Text(invitationUrl) {
  return `Together Ledger\n\nYou have been invited to a shared journey.\n\nTogether Ledger is a private place for two people to hold what happened, return to what matters, and make room for repair.\n\nOpen your invitation: ${invitationUrl}\n\nSign in with your own account to accept. This short-lived link works once.\n\nDid not expect this? You can safely ignore this email.\n\nTogether Ledger`;
}

function email0010Invitation(invitationUrl) {
  const safeUrl = escapeHtml(invitationUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>You have been invited to Together Ledger</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f1ee;color:#2c2531;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">A private shared journey is ready when you are.</span>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f1ee;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#fffdfb;border:1px solid #e5dcd8;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:30px 36px 24px;background:#3b2c3e;color:#fffdfb;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="width:40px;height:40px;border-radius:12px;background:#d7b9e7;color:#302536;text-align:center;font-size:17px;font-weight:700;line-height:40px;">TL</td>
                    <td style="padding-left:12px;font-size:19px;font-weight:700;letter-spacing:-0.2px;">Together Ledger</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:38px 36px 32px;">
                <p style="margin:0 0 12px;color:#816469;font-size:13px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;">A private shared journey</p>
                <h1 style="margin:0 0 18px;color:#2c2531;font-size:30px;line-height:1.18;letter-spacing:-0.6px;">You have been invited.</h1>
                <p style="margin:0 0 16px;color:#4b404a;font-size:17px;line-height:1.55;">Someone you trust has made room for you in a Together Ledger journey.</p>
                <p style="margin:0 0 28px;color:#4b404a;font-size:17px;line-height:1.55;">It is a private place for two people to hold what happened, return to what matters, and make room for repair.</p>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 28px;">
                  <tr>
                    <td bgcolor="#5b355f" style="border-radius:9px;">
                      <a href="${safeUrl}" style="display:inline-block;padding:14px 20px;color:#ffffff;font-size:16px;font-weight:700;line-height:20px;text-decoration:none;">Open your invitation</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 24px;color:#665a63;font-size:14px;line-height:1.55;">Sign in with your own account to accept. This short-lived link works once.</p>
                <p style="margin:0 0 8px;color:#665a63;font-size:13px;line-height:1.5;">If the button does not open, copy this link into your browser:</p>
                <p style="margin:0 0 28px;font-size:13px;line-height:1.5;overflow-wrap:anywhere;word-break:break-word;"><a href="${safeUrl}" style="color:#5b355f;text-decoration:underline;">${safeUrl}</a></p>
                <hr style="border:0;border-top:1px solid #e9e1dd;margin:0 0 20px;" />
                <p style="margin:0;color:#665a63;font-size:13px;line-height:1.5;">Did not expect this invitation? You can safely ignore this email. It will not make changes to an account on its own.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 36px;background:#f8f4f1;color:#766a72;font-size:12px;line-height:1.5;">Together Ledger is a private shared journey workspace for two people.</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function email0020Text(verificationUrl) {
  return `Together Ledger\n\nOne small step, then you’re in.\n\nVerify this email address to finish setting up your Together Ledger account.\n\nVerify email address: ${verificationUrl}\n\nThis short-lived link works once. If you did not create an account, you can safely ignore this email.\n\nTogether Ledger`;
}

function email0020Verification(verificationUrl) {
  const safeUrl = escapeHtml(verificationUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>Verify your Together Ledger email</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f1ee;color:#2c2531;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">Verify your email address to finish setting up Together Ledger.</span>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f1ee;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#fffdfb;border:1px solid #e5dcd8;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:30px 36px 24px;background:#3b2c3e;color:#fffdfb;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="width:40px;height:40px;border-radius:12px;background:#d7b9e7;color:#302536;text-align:center;font-size:17px;font-weight:700;line-height:40px;">TL</td>
                    <td style="padding-left:12px;font-size:19px;font-weight:700;letter-spacing:-0.2px;">Together Ledger</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:38px 36px 32px;">
                <p style="margin:0 0 12px;color:#816469;font-size:13px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;">Confirm your email address</p>
                <h1 style="margin:0 0 18px;color:#2c2531;font-size:30px;line-height:1.18;letter-spacing:-0.6px;">One small step, then you’re in.</h1>
                <p style="margin:0 0 28px;color:#4b404a;font-size:17px;line-height:1.55;">Verify this email address to finish setting up your Together Ledger account.</p>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 28px;">
                  <tr>
                    <td bgcolor="#5b355f" style="border-radius:9px;">
                      <a href="${safeUrl}" style="display:inline-block;padding:14px 20px;color:#ffffff;font-size:16px;font-weight:700;line-height:20px;text-decoration:none;">Verify email address</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 24px;color:#665a63;font-size:14px;line-height:1.55;">This short-lived link works once.</p>
                <p style="margin:0 0 8px;color:#665a63;font-size:13px;line-height:1.5;">If the button does not open, copy this link into your browser:</p>
                <p style="margin:0 0 28px;font-size:13px;line-height:1.5;overflow-wrap:anywhere;word-break:break-word;"><a href="${safeUrl}" style="color:#5b355f;text-decoration:underline;">${safeUrl}</a></p>
                <hr style="border:0;border-top:1px solid #e9e1dd;margin:0 0 20px;" />
                <p style="margin:0;color:#665a63;font-size:13px;line-height:1.5;">Did not create an account? You can safely ignore this email. It will not make changes to an account on its own.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 36px;background:#f8f4f1;color:#766a72;font-size:12px;line-height:1.5;">Together Ledger is a private shared journey workspace for two people.</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
import nodemailer from 'nodemailer';
