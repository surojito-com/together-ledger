import { createHash, createHmac, randomBytes } from 'node:crypto';
import argon2 from 'argon2';

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLocaleLowerCase('en-US');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter a valid email address.');
  return email;
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

export function csrfForSession(secret, rawSessionToken) {
  return createHmac('sha256', secret).update(`csrf:${rawSessionToken}`).digest('base64url');
}
