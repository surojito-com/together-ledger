export class ApiError extends Error {
  constructor(message, { code = 'request_failed', status = 0 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function configuredBase() {
  const configuredOrigin = typeof document !== 'undefined'
    ? document.querySelector('meta[name="together-api-origin"]')?.content.trim()
    : '';
  return configuredOrigin ? `${configuredOrigin.replace(/\/$/, '')}/api/v1` : '/api/v1';
}

export class TogetherApi {
  constructor(base = configuredBase()) {
    this.base = base;
    this.csrfToken = '';
    this.crossOrigin = typeof location !== 'undefined' && new URL(base, location.href).origin !== location.origin;
  }

  async request(path, { method = 'GET', body, authenticatedMutation = false } = {}) {
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
}
