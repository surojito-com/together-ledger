import { generateKeyPairSync, sign } from 'node:crypto';

// A stand-in for Google's OIDC signing keys (#273), so a test can sign the token a Pub/Sub push
// subscription sends, and serve the keys from the URL GooglePushVerifier reads them from. The keys
// are made here and never leave the test.

export const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const PUSH_AUDIENCE = 'https://api.together-ledger.test/api/v1/billing/store-notifications/google';
export const PUSH_EMAIL = 'play-notifications@together-ledger-test.iam.gserviceaccount.com';

export function googleKeys() {
  const pair = (kid) => ({ kid, ...generateKeyPairSync('rsa', { modulusLength: 2048 }) });
  const published = [pair('google-key-1')];
  const calls = [];
  const state = { available: true, maxAge: 3600 };
  const fetch = async (url) => {
    calls.push(url);
    if (url !== GOOGLE_KEYS_URL) throw new Error(`Unexpected fetch of ${url}`);
    if (!state.available) return { ok: false, status: 503, json: async () => ({}), headers: { get: () => null } };
    const keys = published.map(({ kid, publicKey }) => ({ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }));
    return { ok: true, status: 200, json: async () => ({ keys }), headers: { get: (name) => (name === 'cache-control' ? `public, max-age=${state.maxAge}` : null) } };
  };
  // A key Google has published, or (`publish: false`) one it never has.
  const rotate = ({ publish = true } = {}) => {
    const next = pair(`google-key-${published.length + 1}${publish ? '' : '-unpublished'}`);
    if (publish) published.push(next);
    return next;
  };
  return { fetch, calls, state, rotate, current: () => published[0] };
}

export function pushToken(key, claims = {}, { now = Date.now(), header = {} } = {}) {
  const seconds = Math.floor(now / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    aud: PUSH_AUDIENCE,
    azp: '113774264463038321964',
    email: PUSH_EMAIL,
    email_verified: true,
    iss: 'https://accounts.google.com',
    sub: '113774264463038321964',
    iat: seconds,
    exp: seconds + 3600,
    ...claims,
  })).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

// What a Pub/Sub push subscription POSTs: the DeveloperNotification, base64, inside a message.
export function pushBody(notification, { messageId = '1000000000000001' } = {}) {
  return {
    message: { data: Buffer.from(JSON.stringify(notification)).toString('base64'), messageId, publishTime: '2026-10-10T12:00:00.000Z' },
    subscription: 'projects/togetherledger-app/subscriptions/play-notifications-push',
  };
}
