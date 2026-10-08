import { createHash, createHmac, randomBytes } from 'node:crypto';
import argon2 from 'argon2';

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLocaleLowerCase('en-US');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter a valid email address.');
  return email;
}

// An invited person's email as the people in a journey see it, and as its history keeps it (owner,
// Oct 8, 2026, #348, #350): the first letter, always exactly two bullets, the last letter, then the
// whole domain. A one- or two-letter name keeps only its first letter, so neither the name's length
// nor all of it is ever told. History cannot be edited, and a person who is never added has not
// agreed to be in it.
export function maskEmail(value) {
  const email = String(value || '');
  const at = email.lastIndexOf('@');
  if (at < 1) return '\u2022\u2022';
  const name = Array.from(email.slice(0, at));
  const shown = name.length <= 2 ? `${name[0]}\u2022\u2022` : `${name[0]}\u2022\u2022${name[name.length - 1]}`;
  return `${shown}@${email.slice(at + 1)}`;
}

export function assertPassword(value) {
  const password = String(value || '');
  if (password.length < 12 || password.length > 128) throw new Error('Use a password between 12 and 128 characters.');
  return password;
}

export async function hashPassword(password) {
  return argon2.hash(assertPassword(password), {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, String(password || ''), { type: argon2.argon2id });
  } catch {
    return false;
  }
}

export function opaqueToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

export function eventHmac(key, event) {
  return createHmac('sha256', key).update(canonicalize(event)).digest('hex');
}

// A bearer token is read only from the Authorization header, never from a query string, so it
// cannot be captured by a proxy log, a browser history entry, or a referrer.
export function bearerTokenFrom(authorizationHeader) {
  const header = String(authorizationHeader || '').trim();
  if (!/^Bearer /i.test(header)) return '';
  return header.slice(7).trim();
}

export function csrfForSession(secret, rawSessionToken) {
  return createHmac('sha256', secret).update(`csrf:${rawSessionToken}`).digest('base64url');
}
