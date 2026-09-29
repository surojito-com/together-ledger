export class ApiError extends Error {
  constructor(message, { code = 'request_failed', status = 0 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
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
  }

  async request(path, { method = 'GET', body, authenticatedMutation = false } = {}) {
    if (!this.accountsAvailable) throw new ApiError('Private accounts are being connected. No account details were sent.', { code: 'accounts_unavailable' });
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

  async logout() {
    await this.request('/auth/logout', { method: 'POST', authenticatedMutation: true });
    this.csrfToken = '';
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
    let response;
    try {
      response = await fetch(this.imageUrl(journeyId, momentId, imageId), {
        credentials: this.crossOrigin ? 'include' : 'same-origin',
      });
    } catch {
      throw new ApiError('The photo could not be reached right now.', { code: 'offline' });
    }
    if (!response.ok) throw new ApiError('The photo could not be opened right now.', { code: 'image_unavailable', status: response.status });
    return response.blob();
  }

  async uploadMomentImage(journeyId, momentId, file, paidSlotId = '') {
    const slot = paidSlotId ? `?paidSlotId=${encodeURIComponent(paidSlotId)}` : '';
    const response = await fetch(`${this.base}/journeys/${encodeURIComponent(journeyId)}/moments/${encodeURIComponent(momentId)}/images${slot}`, {
      method: 'POST', credentials: this.crossOrigin ? 'include' : 'same-origin', headers: { 'Content-Type': file.type, 'X-Together-CSRF': this.csrfToken, 'X-Together-Image-Name': encodeURIComponent(file.name) }, body: file,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(payload?.error?.message || 'The image could not be added.', { code: payload?.error?.code, status: response.status });
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
