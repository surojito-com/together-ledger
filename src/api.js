import { stripPhotoMetadata } from './photo-metadata.js';

export class ApiError extends Error {
  constructor(message, { code = 'request_failed', status = 0, details = null, sessionEnded = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    // True when this request was sent signed in and the service refused that sign-in (#194).
    this.sessionEnded = sessionEnded;
  }
}

function configuredApiOrigin() {
  const configuredOrigin = typeof document !== 'undefined'
    ? document.querySelector('meta[name="together-api-origin"]')?.content.trim()
    : '';
  return configuredOrigin;
}

function configuredBase() {
  const origin = configuredApiOrigin();
  return origin ? `${origin.replace(/\/$/, '')}/api/v1` : '/api/v1';
}

function pageEnablesAccounts() {
  const enabled = typeof document !== 'undefined'
    ? document.querySelector('meta[name="together-accounts-enabled"]')?.content.trim()
    : '';
  return enabled === 'true';
}

function hasDevelopmentApi() {
  if (typeof location === 'undefined') return true;
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

export class TogetherApi {
  constructor(base = configuredBase()) {
    this.base = base;
    this.csrfToken = '';
    this.accountsAvailable = pageEnablesAccounts() || Boolean(configuredApiOrigin()) || hasDevelopmentApi();
    this.crossOrigin = typeof location !== 'undefined' && new URL(base, location.href).origin !== location.origin;
    // Called when the service refuses the session this page was signed in with (#194): it ended
    // elsewhere, by Sign out everywhere, a password change or a recovery, or it ran out. Only a
    // page that was signed in hears it, so a visitor who never signed in is never told they were
    // signed out, and a wrong password (`invalid_credentials`) is never mistaken for it.
    this.onSignedOut = null;
  }

  // Whether a request sent while signed in came back refused for that reason. Several can be on
  // their way together; each says so, and the page is told once. A refusal of a session this page
  // has already left behind (it signed in again meanwhile) ends nothing.
  sessionEndedBy(sentWith, status, code) {
    if (!sentWith || status !== 401 || code !== 'authentication_required') return false;
    if (this.csrfToken === sentWith) {
      this.csrfToken = '';
      this.onSignedOut?.();
    }
    return true;
  }

  async request(path, { method = 'GET', body, authenticatedMutation = false } = {}) {
    if (!this.accountsAvailable) throw new ApiError('Private accounts are being connected. No account details were sent.', { code: 'accounts_unavailable' });
    const sentWith = this.csrfToken;
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticatedMutation) headers['X-Together-CSRF'] = this.csrfToken;
    let response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        credentials: this.crossOrigin ? 'include' : 'same-origin',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('Private sync is temporarily unreachable.', { code: 'offline' });
    }
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(payload?.error?.message || 'The service could not complete that request.', {
        code: payload?.error?.code,
        status: response.status,
        details: payload?.error?.details ?? null,
        sessionEnded: this.sessionEndedBy(sentWith, response.status, payload?.error?.code),
      });
    }
    return payload?.data ?? null;
  }

  async session() {
    const data = await this.request('/session');
    this.csrfToken = data.csrfToken;
    return data.user;
  }

  async register(input) {
    const data = await this.request('/auth/register', { method: 'POST', body: input });
    this.csrfToken = data.csrfToken;
    this.lastVerificationSent = data.verificationSent;
    return data.user;
  }

  async login(input) {
    const data = await this.request('/auth/login', { method: 'POST', body: input });
    this.csrfToken = data.csrfToken;
    return data.user;
  }

  // Which of Google and Apple this server can sign a browser in with (#216). Public identifiers
  // only; nothing about an account.
  providers() {
    return this.request('/auth/providers');
  }

  // Google's or Apple's ID token goes to the server and nowhere else. The reply is a password
  // sign-in's: the session cookie, and the CSRF token kept here in memory. Nothing is stored.
  async socialSignIn(provider, body) {
    const data = await this.request(`/auth/${provider}`, { method: 'POST', body });
    this.csrfToken = data.csrfToken;
    return data.user;
  }

  // The answer to `link_required`: the same sign-in, with the password of the account that
  // already uses its email.
  async linkIdentity(body) {
    const data = await this.request('/auth/link', { method: 'POST', body });
    this.csrfToken = data.csrfToken;
    return data.user;
  }

  async logout() {
    await this.request('/auth/logout', { method: 'POST', authenticatedMutation: true });
    this.csrfToken = '';
  }

  // Every browser and phone signed in to the account, this one included (#194).
  async logoutEverywhere() {
    await this.request('/auth/logout-everywhere', { method: 'POST', authenticatedMutation: true });
    this.csrfToken = '';
  }

  // This browser stays signed in with the session it has; every other one ends (#194).
  async changePassword(currentPassword, newPassword) {
    const data = await this.request('/account/password', { method: 'POST', body: { currentPassword, newPassword }, authenticatedMutation: true });
    return data.user;
  }

  mutate(path, method, body) {
    return this.request(path, { method, body, authenticatedMutation: true });
  }

  // The token goes in the body so it never appears in a logged address (issue #208). An API that
  // predates that route answers with Fastify's own 404, which carries no error code, so ApiError
  // falls back to 'request_failed'; only then does this retry the older path form. A real
  // invitation error always carries its own code and is shown as it is.
  async acceptInvitation(token) {
    try {
      return await this.mutate('/invitations/accept', 'POST', { token });
    } catch (error) {
      if (error.status !== 404 || error.code !== 'request_failed') throw error;
      return this.mutate(`/invitations/${encodeURIComponent(token)}/accept`, 'POST', {});
    }
  }

  imageUrl(journeyId, momentId, imageId) {
    return `${this.base}/journeys/${encodeURIComponent(journeyId)}/moments/${encodeURIComponent(momentId)}/images/${encodeURIComponent(imageId)}`;
  }

  async momentImageBlob(journeyId, momentId, imageId) {
    const sentWith = this.csrfToken;
    let response;
    try {
      response = await fetch(this.imageUrl(journeyId, momentId, imageId), {
        credentials: this.crossOrigin ? 'include' : 'same-origin',
      });
    } catch {
      throw new ApiError('The photo could not be reached right now.', { code: 'offline' });
    }
    if (!response.ok) {
      // An image answers with no JSON; on this route only a refused sign-in is a 401.
      const sessionEnded = this.sessionEndedBy(sentWith, response.status, response.status === 401 ? 'authentication_required' : '');
      throw new ApiError('The photo could not be opened right now.', { code: 'image_unavailable', status: response.status, sessionEnded });
    }
    return response.blob();
  }

  // The photo's location and camera details are removed here, before anything is sent (#258). The
  // dialog has usually done it already, when the photo was picked; doing it again costs nothing
  // and means no caller can send a photo as it came. A file that cannot be read is not sent.
  async uploadMomentImage(journeyId, momentId, file, paidSlotId = '') {
    const sentWith = this.csrfToken;
    const { bytes, contentType } = stripPhotoMetadata(new Uint8Array(await file.arrayBuffer()));
    const slot = paidSlotId ? `?paidSlotId=${encodeURIComponent(paidSlotId)}` : '';
    const response = await fetch(`${this.base}/journeys/${encodeURIComponent(journeyId)}/moments/${encodeURIComponent(momentId)}/images${slot}`, {
      method: 'POST', credentials: this.crossOrigin ? 'include' : 'same-origin', headers: { 'Content-Type': contentType, 'X-Together-CSRF': this.csrfToken, 'X-Together-Image-Name': encodeURIComponent(file.name) }, body: bytes,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const sessionEnded = this.sessionEndedBy(sentWith, response.status, payload?.error?.code);
      throw new ApiError(payload?.error?.message || 'The image could not be added.', { code: payload?.error?.code, status: response.status, sessionEnded });
    }
    return payload?.data?.image;
  }

  deleteMomentImage(journeyId, momentId, imageId) {
    return this.mutate(`/journeys/${encodeURIComponent(journeyId)}/moments/${encodeURIComponent(momentId)}/images/${encodeURIComponent(imageId)}`, 'DELETE');
  }

  imageSlots(journeyId, momentId) {
    return this.request(`/journeys/${journeyId}/moments/${momentId}/image-slots`);
  }

  createImageCheckout(journeyId, momentId) {
    return this.mutate(`/journeys/${journeyId}/moments/${momentId}/image-slots/checkout-sessions`, 'POST', { requestId: crypto.randomUUID() });
  }

  createLocationCheckout(journeyId, momentId) {
    return this.mutate(`/journeys/${journeyId}/moments/${momentId}/location-slots/checkout-sessions`, 'POST', { requestId: crypto.randomUUID() });
  }
}
