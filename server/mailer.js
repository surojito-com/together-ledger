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
  constructor({ smtpUrl, from, publicOrigin, transport }) {
    this.transport = transport || nodemailer.createTransport(smtpUrl);
    this.from = from;
    this.publicOrigin = publicOrigin;
  }

  send({ to, subject, text }) {
    return this.transport.sendMail({ from: this.from, to, subject, text });
  }

  sendInvitation({ to, token }) {
    return this.send({
      to,
      subject: 'You are invited to a Together Ledger journey',
      text: `A journey owner invited this email address. Sign in with your own account and accept: ${this.publicOrigin}/?invite=${encodeURIComponent(token)}\n\nIf you did not expect this invitation, ignore this message.`,
    });
  }

  sendRecovery({ to, token }) {
    return this.send({
      to,
      subject: 'Reset your Together Ledger password',
      text: `Reset your password: ${this.publicOrigin}/?recovery=${encodeURIComponent(token)}\n\nThis short-lived link works once. If you did not request it, ignore this message.`,
    });
  }

  sendVerification({ to, token }) {
    return this.send({
      to,
      subject: 'Verify your Together Ledger email',
      text: `Verify this email address: ${this.publicOrigin}/?verify=${encodeURIComponent(token)}\n\nThis short-lived link works once.`,
    });
  }
}
import nodemailer from 'nodemailer';
