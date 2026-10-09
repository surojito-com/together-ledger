import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

// The Google Play Developer API, as much of it as turning a purchase into capacity needs (#272).
// Unlike Apple, Google gives the phone nothing it can check offline: the phone forwards a purchase
// token, and only Google can say what it bought. So every Google purchase is looked up here,
// server to server, with a service account that never leaves the server.
//
// The purchase service uses this through five methods, and its tests use recorded responses in
// their place (tests/fixtures/google-play), because no Google credentials exist where it was
// written:
//
//   productPurchase(productId, token)          purchases.products.get
//   subscriptionPurchase(token)                purchases.subscriptionsv2.get
//   consumeProduct(productId, token)           purchases.products.consume
//   acknowledgeSubscription(productId, token)  purchases.subscriptions.acknowledge
//   voidedPurchases({ since })                 purchases.voidedpurchases.list (#273)
//
// Consuming a one-time product also acknowledges it, and makes it possible to buy again, which a
// pass and an extra both need. Google recommends doing it from a secure backend rather than the
// phone. A purchase not acknowledged within three days is refunded by Google, silently, and its
// entitlement revoked.
//
// Access is an OAuth token from Google's JWT bearer flow: a JWT signed RS256 with the service
// account's key, exchanged at its token_uri for an hour-long token, which is reused until a few
// minutes before it ends.
//
// Sources, read Oct 8, 2026:
//   https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products
//   https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2
//   https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions/acknowledge
//   https://developer.android.com/google/play/billing/integrate (three days; consume from the backend)
//   https://developers.google.com/identity/protocols/oauth2/service-account (the JWT bearer flow)
// and, read Oct 9, 2026, for what Google says afterwards (#273):
//   https://developer.android.com/google/play/billing/rtdn-reference
//   https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.voidedpurchases/list
//   https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 8000;
const TOKEN_REFRESH_MS = 5 * 60 * 1000;
// Voided purchases are listed, not looked up by token. A page holds up to 1000; at most this many
// are read for one notification.
const VOIDED_PAGES = 5;

// What went wrong talking to Google, in the three shapes the purchase service treats differently:
// `not-found` (Google does not know this purchase: never ours to grant), `refused` (Google refused
// our credentials: our configuration, not the person's purchase) and `unavailable` (try again).
export class GooglePlayError extends Error {
  constructor(kind, status = null) {
    super(`Google Play ${kind}${status ? ` (${status})` : ''}.`);
    this.name = 'GooglePlayError';
    this.kind = kind;
    this.status = status;
  }
}

// The service account key arrives as the JSON file Google gives you, on one line, or base64 of it.
export function parseServiceAccount(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const json = text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8');
  let account;
  try {
    account = JSON.parse(json);
  } catch {
    throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT must be the service account key JSON, or base64 of it.');
  }
  if (!account.client_email || !account.private_key) throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT must carry client_email and private_key.');
  createPrivateKey(account.private_key);
  return { clientEmail: account.client_email, privateKey: account.private_key, tokenUri: account.token_uri || DEFAULT_TOKEN_URI };
}

function segment(value) {
  return encodeURIComponent(String(value));
}

export class GooglePlayDeveloperApi {
  constructor({ serviceAccount, packageName, fetch = globalThis.fetch, now = () => Date.now() }) {
    this.serviceAccount = serviceAccount;
    this.packageName = packageName;
    this.fetch = fetch;
    this.now = now;
    this.token = null;
  }

  async accessToken() {
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_MS > this.now()) return this.token.value;
    const issuedAt = Math.floor(this.now() / 1000);
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
      iss: this.serviceAccount.clientEmail,
      scope: SCOPE,
      aud: this.serviceAccount.tokenUri,
      iat: issuedAt,
      exp: issuedAt + 60 * 60,
    })).toString('base64url');
    const signature = sign('sha256', Buffer.from(`${head}.${body}`), createPrivateKey(this.serviceAccount.privateKey)).toString('base64url');
    let response;
    try {
      response = await this.fetch(this.serviceAccount.tokenUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${signature}` }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GooglePlayError('unavailable');
    }
    if (response.status >= 500) throw new GooglePlayError('unavailable', response.status);
    if (!response.ok) throw new GooglePlayError('refused', response.status);
    const granted = await response.json();
    if (!granted.access_token) throw new GooglePlayError('refused', response.status);
    this.token = { value: granted.access_token, expiresAt: this.now() + Number(granted.expires_in || 3600) * 1000 };
    return this.token.value;
  }

  async call(method, path) {
    const token = await this.accessToken();
    let response;
    try {
      response = await this.fetch(`${API}/${segment(this.packageName)}/purchases/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: '{}' } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GooglePlayError('unavailable');
    }
    // Google answers a token it never issued, or one for another app, with 400, 404 or 410.
    if ([400, 404, 410].includes(response.status)) throw new GooglePlayError('not-found', response.status);
    if (response.status === 401 || response.status === 403) {
      this.token = null;
      throw new GooglePlayError('refused', response.status);
    }
    if (!response.ok) throw new GooglePlayError('unavailable', response.status);
    const text = await response.text();
    if (!text) return {};
    // A 200 that is not JSON (a proxy's page, a cut-off body) is Google being unavailable, not an
    // answer about the purchase.
    try {
      return JSON.parse(text);
    } catch {
      throw new GooglePlayError('unavailable', response.status);
    }
  }

  productPurchase(productId, token) {
    return this.call('GET', `products/${segment(productId)}/tokens/${segment(token)}`);
  }

  subscriptionPurchase(token) {
    return this.call('GET', `subscriptionsv2/tokens/${segment(token)}`);
  }

  async consumeProduct(productId, token) {
    await this.call('POST', `products/${segment(productId)}/tokens/${segment(token)}:consume`);
  }

  async acknowledgeSubscription(productId, token) {
    await this.call('POST', `subscriptions/${segment(productId)}/tokens/${segment(token)}:acknowledge`);
  }

  // Every purchase Google has voided (refunded, charged back or revoked) since `since`, passes,
  // extras and subscriptions alike (type 1). Google filters by when it saw the purchase voided, and
  // looks back at most 30 days. A subscription's renewals share its token, so each void names its
  // order (orderId). A quantity-based partial refund is not listed here; a refund of what is left
  // is (includeQuantityBasedPartialRefund stays false).
  async voidedPurchases({ since }) {
    const found = [];
    let page = null;
    for (let read = 0; read < VOIDED_PAGES; read += 1) {
      const query = new URLSearchParams({ type: '1', ...(page ? { 'pageSelection.token': page } : { startTime: String(since) }) });
      const answer = await this.call('GET', `voidedpurchases?${query}`);
      found.push(...(Array.isArray(answer.voidedPurchases) ? answer.voidedPurchases : []));
      page = answer.tokenPagination?.nextPageToken;
      if (!page) break;
    }
    return found;
  }
}

// --- Real-time developer notifications (#273) ---------------------------------------------------
//
// Google Play publishes what happens to a purchase afterwards to a Pub/Sub topic, and a push
// subscription delivers each message here over HTTPS. Anyone can send a request to that URL, so
// every one must carry the OIDC token Pub/Sub signs for the push subscription's service account:
// `Authorization: Bearer <JWT>`, RS256, signed with one of Google's published keys, issued by
// accounts.google.com, for the audience set on the subscription, naming that service account's
// email, verified. Both the audience and the email come from configuration; with either missing,
// nothing is accepted.
//
// Google's keys rotate. They are fetched, kept for as long as Google's Cache-Control says, and
// fetched again early only when a token names a key we don't hold, at most once a minute.

const GOOGLE_KEYS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const CLOCK_SKEW_S = 300;
const KEYS_DEFAULT_MS = 60 * 60 * 1000;
const KEYS_REFETCH_MS = 60 * 1000;
const MAX_PUSH_TOKEN_LENGTH = 4096;

// `unauthenticated`: the request is not from our push subscription, whatever it says.
// `unavailable`: Google's keys couldn't be read, so nothing can be checked; Pub/Sub sends again.
export class GooglePushError extends Error {
  constructor(kind, reason) {
    super(`Google push ${kind}: ${reason}.`);
    this.name = 'GooglePushError';
    this.kind = kind;
    this.reason = reason;
  }
}

function part(value) {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export class GooglePushVerifier {
  constructor({ audience, serviceAccountEmail, fetch = globalThis.fetch, now = () => Date.now() }) {
    this.audience = audience;
    this.serviceAccountEmail = String(serviceAccountEmail || '').toLowerCase();
    this.fetch = fetch;
    this.now = now;
    this.keys = new Map();
    this.keysUntil = 0;
    this.fetchedAt = -Infinity;
  }

  async verify(authorization) {
    const refused = (reason) => new GooglePushError('unauthenticated', reason);
    if (!this.audience || !this.serviceAccountEmail) throw refused('not configured');
    const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(authorization || ''));
    if (!match || authorization.length > MAX_PUSH_TOKEN_LENGTH) throw refused('no token');
    const [, head, body, signature] = match;
    const header = part(head);
    const claims = part(body);
    if (!header || !claims) throw refused('unreadable token');
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw refused('not RS256');
    const key = await this.key(header.kid);
    if (!key) throw refused('unknown key');
    if (!verify('sha256', Buffer.from(`${head}.${body}`), key, Buffer.from(signature, 'base64url'))) throw refused('bad signature');
    const seconds = this.now() / 1000;
    if (!GOOGLE_ISSUERS.has(claims.iss)) throw refused('wrong issuer');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(this.audience)) throw refused('wrong audience');
    if (String(claims.email || '').toLowerCase() !== this.serviceAccountEmail || claims.email_verified !== true) throw refused('wrong service account');
    if (!Number.isFinite(claims.exp) || claims.exp + CLOCK_SKEW_S < seconds) throw refused('expired');
    if (Number.isFinite(claims.iat) && claims.iat - CLOCK_SKEW_S > seconds) throw refused('issued in the future');
    return claims;
  }

  async key(kid) {
    const now = this.now();
    const fresh = now < this.keysUntil;
    if (fresh && this.keys.has(kid)) return this.keys.get(kid);
    if (!fresh || now - this.fetchedAt >= KEYS_REFETCH_MS) await this.fetchKeys();
    return this.keys.get(kid) || null;
  }

  async fetchKeys() {
    this.fetchedAt = this.now();
    let response;
    let body;
    try {
      response = await this.fetch(GOOGLE_KEYS, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(String(response.status));
      body = await response.json();
    } catch {
      // Keys already held stay usable until they lapse.
      if (this.keys.size && this.now() < this.keysUntil) return;
      throw new GooglePushError('unavailable', 'Google’s keys could not be read');
    }
    const keys = new Map();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
      } catch {
        // A key that isn't one is skipped; a token naming it is refused.
      }
    }
    if (!keys.size) throw new GooglePushError('unavailable', 'Google published no keys');
    const maxAge = /max-age=(\d+)/.exec(response.headers?.get?.('cache-control') || '');
    this.keys = keys;
    this.keysUntil = this.now() + (maxAge ? Number(maxAge[1]) * 1000 : KEYS_DEFAULT_MS);
  }
}
