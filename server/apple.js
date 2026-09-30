import { createCipheriv, createDecipheriv, createPrivateKey, randomBytes, sign } from 'node:crypto';

// Sign in with Apple's REST API: the part of Apple sign-in that checking an ID token can't do.
//
// Apple requires an app that offers Sign in with Apple to revoke the person's tokens when they
// delete their account (#218). Revoking needs a token Apple issued to us, so a sign-in also sends
// Apple's one-time authorization code, and exchangeCode() trades it for a refresh token. That
// token is kept encrypted (sealSecret below) and revoked when the account is deleted.
//
// Every call to Apple carries a client secret: an ES256 JWT signed with this app's Sign in with
// Apple key (.p8), with kid = the key's ID, iss = the Team ID, sub = the client ID the code was
// issued to (the App ID for the phone, the Services ID for the web), aud =
// https://appleid.apple.com. Apple accepts one valid for up to six months; one is signed per
// client ID and reused for a day.
//
// Sources, checked Sep 30, 2026:
//   https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens
//   https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens
//   https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret
const APPLE = 'https://appleid.apple.com';
const SECRET_TTL_S = 24 * 60 * 60;
const SECRET_REFRESH_S = 60 * 60;
const APPLE_TIMEOUT_MS = 8000;

// The key reaches the server through an environment file, which holds one line per value, so
// the PEM armour and line breaks are optional.
function privateKeyFrom(value) {
  const body = String(value).replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const pem = `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
  return createPrivateKey(pem);
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export class AppleSignIn {
  constructor({ teamId, keyId, privateKey, encryptionKey, redirectUri = '', fetch = globalThis.fetch, now = () => Date.now() }) {
    this.teamId = teamId;
    this.keyId = keyId;
    this.privateKey = privateKey;
    this.encryptionKey = encryptionKey;
    this.redirectUri = redirectUri;
    this.fetch = fetch;
    this.now = now;
    this.secrets = new Map();
  }

  // Without the key or the encryption key nothing can be exchanged or revoked, so no new Apple
  // account is opened: one whose tokens could never be revoked is one App Review would refuse.
  configured() {
    return Boolean(this.teamId && this.keyId && this.privateKey && this.encryptionKey);
  }

  clientSecret(clientId) {
    const nowS = Math.floor(this.now() / 1000);
    const cached = this.secrets.get(clientId);
    if (cached && cached.expiresAt - SECRET_REFRESH_S > nowS) return cached.secret;
    const expiresAt = nowS + SECRET_TTL_S;
    const head = base64url({ alg: 'ES256', kid: this.keyId });
    const body = base64url({ iss: this.teamId, iat: nowS, exp: expiresAt, aud: APPLE, sub: clientId });
    // Apple wants the raw R||S signature, not DER (TN3107), which is what ieee-p1363 produces.
    const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKeyFrom(this.privateKey), dsaEncoding: 'ieee-p1363' });
    const secret = `${head}.${body}.${signature.toString('base64url')}`;
    this.secrets.set(clientId, { secret, expiresAt });
    return secret;
  }

  async post(path, form) {
    return this.fetch(`${APPLE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(APPLE_TIMEOUT_MS),
    });
  }

  // { ok: true, refreshToken, idToken } or { ok: false, reason }. `invalid_grant` means the code
  // expired (five minutes), was used, or isn't this person's; `unavailable` means Apple couldn't
  // be reached; `misconfigured` means our key, secret, client ID or return URL was refused.
  async exchangeCode({ code, clientId, webFlow = false }) {
    const form = { client_id: clientId, client_secret: this.clientSecret(clientId), code: String(code || ''), grant_type: 'authorization_code' };
    // Only a code from Sign in with Apple JS was requested with a return URL, so only its exchange
    // repeats one. A native code's exchange must not send it.
    if (webFlow && this.redirectUri) form.redirect_uri = this.redirectUri;
    let response;
    try {
      response = await this.post('/auth/token', form);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (response.status >= 500) return { ok: false, reason: 'unavailable' };
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, reason: body.error === 'invalid_grant' ? 'invalid_grant' : 'misconfigured', error: body.error };
    if (typeof body.refresh_token !== 'string' || typeof body.id_token !== 'string') return { ok: false, reason: 'unavailable' };
    return { ok: true, refreshToken: body.refresh_token, idToken: body.id_token };
  }

  // Apple answers 200 both when it revokes a token and when the token was already invalid.
  // 'revoked', 'retry' (unreachable or 5xx) or 'misconfigured' (retried too: fixing the key makes
  // the same row succeed).
  async revoke({ refreshToken, clientId }) {
    let response;
    try {
      response = await this.post('/auth/revoke', {
        client_id: clientId,
        client_secret: this.clientSecret(clientId),
        token: refreshToken,
        token_type_hint: 'refresh_token',
      });
    } catch {
      return 'retry';
    }
    if (response.ok) return 'revoked';
    if (response.status >= 500) return 'retry';
    const body = await response.json().catch(() => ({}));
    return body.error === 'invalid_grant' ? 'revoked' : 'misconfigured';
  }

  sealSecret(plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keyBytes(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  openSecret(sealed) {
    const [version, iv, data] = String(sealed).split('.');
    if (version !== 'v1' || !iv || !data) throw new Error('unrecognised sealed secret');
    const bytes = Buffer.from(data, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.keyBytes(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]).toString('utf8');
  }

  keyBytes() {
    const key = Buffer.from(String(this.encryptionKey || ''), 'base64');
    if (key.length !== 32) throw new Error('APPLE_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64');
    return key;
  }
}

export function appleSignInFor(config, options = {}) {
  return new AppleSignIn({
    teamId: config.APPLE_TEAM_ID,
    keyId: config.APPLE_SIGN_IN_KEY_ID,
    privateKey: config.APPLE_SIGN_IN_PRIVATE_KEY,
    encryptionKey: config.APPLE_TOKEN_ENCRYPTION_KEY,
    redirectUri: config.APPLE_WEB_REDIRECT_URI,
    ...options,
  });
}
