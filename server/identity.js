import { createPublicKey, verify } from 'node:crypto';

// Google and Apple each sign an ID token with a key they publish, and this checks one the way
// they document it: the signature against their published key set, then who issued it (iss),
// who it is for (aud) and whether it is still in date (exp). It uses node:crypto rather than a
// JWT library, so the server takes on no new dependency for something this small.
//
// An account is found by the token's `sub`, the provider's stable user id, and never by its
// email (#214). The email is read only to notice that an account already uses it.
//
// Sources, checked Sep 30, 2026:
//   https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
//   https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple
const PROVIDERS = {
  google: {
    keysUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
  },
  apple: {
    keysUrl: 'https://appleid.apple.com/auth/keys',
    issuers: ['https://appleid.apple.com'],
  },
};

// A key set is cached for an hour. A token signed with a key not in the cache asks again, but no
// more than once a minute, so a stream of made-up key ids cannot turn into a stream of requests.
const KEYS_TTL_MS = 60 * 60 * 1000;
const KEYS_REFETCH_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;

function decodePart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

// Apple writes these claims as either the string "true" or a boolean.
function claimIsTrue(value) {
  return value === true || value === 'true';
}

export class IdentityVerifier {
  constructor({ googleClientIds = [], appleClientIds = [], fetch = globalThis.fetch, now = () => Date.now() } = {}) {
    this.clientIds = { google: googleClientIds, apple: appleClientIds };
    this.fetch = fetch;
    this.now = now;
    this.keys = { google: null, apple: null };
  }

  configured(provider) {
    return Boolean(PROVIDERS[provider] && this.clientIds[provider].length);
  }

  async keyFor(provider, kid) {
    const cached = this.keys[provider];
    const fresh = cached && this.now() - cached.fetchedAt < KEYS_TTL_MS;
    if (fresh && cached.byKid.has(kid)) return cached.byKid.get(kid);
    if (cached && this.now() - cached.fetchedAt < KEYS_REFETCH_MS) return cached.byKid.get(kid) || null;
    const response = await this.fetch(PROVIDERS[provider].keysUrl);
    if (!response.ok) throw new Error(`${provider} key set answered ${response.status}`);
    const { keys = [] } = await response.json();
    this.keys[provider] = { fetchedAt: this.now(), byKid: new Map(keys.filter((key) => key.kid).map((key) => [key.kid, key])) };
    return this.keys[provider].byKid.get(kid) || null;
  }

  // Null when the token doesn't verify, for any reason: the caller answers every one of them the
  // same way. A provider that can't be reached for its keys throws instead, because that is not
  // the person's mistake.
  async verify(provider, idToken) {
    if (!this.configured(provider)) return null;
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) return null;
    let header;
    let claims;
    try {
      header = decodePart(parts[0]);
      claims = decodePart(parts[1]);
    } catch {
      return null;
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

    const jwk = await this.keyFor(provider, header.kid);
    if (!jwk) return null;
    let signed = false;
    try {
      signed = verify(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key: jwk, format: 'jwk' }),
        Buffer.from(parts[2], 'base64url'),
      );
    } catch {
      return null;
    }
    if (!signed) return null;

    const nowS = Math.floor(this.now() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!PROVIDERS[provider].issuers.includes(claims.iss)) return null;
    if (!audiences.some((aud) => this.clientIds[provider].includes(aud))) return null;
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) return null;
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > nowS) return null;
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) return null;

    const email = typeof claims.email === 'string' ? claims.email : null;
    return {
      provider,
      subject: claims.sub,
      email,
      emailVerified: claimIsTrue(claims.email_verified),
      // A Hide My Email relay address never matches an existing account (#214, decided Sep 30, 2026).
      isPrivateEmail: provider === 'apple' && (claimIsTrue(claims.is_private_email) || Boolean(email?.toLowerCase().endsWith('@privaterelay.appleid.com'))),
      // Google carries the person's name in the token. Apple never does; its client sends the
      // name it was given on the first sign-in instead.
      name: typeof claims.name === 'string' ? claims.name : null,
      audience: audiences.find((aud) => this.clientIds[provider].includes(aud)),
    };
  }
}

export function identityVerifierFor(config, options = {}) {
  return new IdentityVerifier({ googleClientIds: config.googleClientIds, appleClientIds: config.appleClientIds, ...options });
}
