import { createPrivateKey, sign } from 'node:crypto';

// The Google Play Developer API, as much of it as turning a purchase into capacity needs (#272).
// Unlike Apple, Google gives the phone nothing it can check offline: the phone forwards a purchase
// token, and only Google can say what it bought. So every Google purchase is looked up here,
// server to server, with a service account that never leaves the server.
//
// The purchase service uses this through four methods, and its tests use recorded responses in
// their place (tests/fixtures/google-play), because no Google credentials exist where it was
// written:
//
//   productPurchase(productId, token)          purchases.products.get
//   subscriptionPurchase(token)                purchases.subscriptionsv2.get
//   consumeProduct(productId, token)           purchases.products.consume
//   acknowledgeSubscription(productId, token)  purchases.subscriptions.acknowledge
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

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 8000;
const TOKEN_REFRESH_MS = 5 * 60 * 1000;

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
    return text ? JSON.parse(text) : {};
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
}
