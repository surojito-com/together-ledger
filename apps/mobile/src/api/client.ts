/**
 * The phone's account client for TL-M-05 (#180), against the bearer-token path from TL-M-04 (#179).
 *
 * Every request says it is the app (`x-together-client: app`), so the server issues tokens rather
 * than a cookie. A signed-in request carries its access token. When that token has expired, the
 * refresh token is spent once for a fresh pair (the server rotates, so a refresh token is never
 * reused) and the request is retried once. If the refresh fails, the stored tokens are cleared
 * and the person is asked to sign in again.
 *
 * The two situations the web client keeps apart stay apart here: `offline` (the service could
 * not be reached) and `accounts_unavailable` (this build has no service to reach at all).
 *
 * Kept free of runtime imports so the tests can run it directly (tests/mobile-account.test.js).
 */
export type AccountUser = {
  id: string;
  email: string;
  username: string;
  displayName: string;
  emailVerified: boolean;
  createdAt: string;
};

export type Tokens = {
  token: string;
  tokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
};

export type TokenStore = {
  read(): Promise<Tokens | null>;
  write(tokens: Tokens): Promise<void>;
  clear(): Promise<void>;
};

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, { code = 'request_failed', status = 0 }: { code?: string; status?: number } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// The web client's own words (src/api.js), not new ones.
export const OFFLINE_MESSAGE = 'Private sync is temporarily unreachable.';
export const UNAVAILABLE_MESSAGE = 'Private accounts are being connected. No account details were sent.';
export const FALLBACK_MESSAGE = 'The service could not complete that request.';
const SIGN_IN_AGAIN_MESSAGE = 'Sign in to continue.';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

type RequestOptions = { method?: string; body?: unknown; signedIn?: boolean };

type Payload = { data?: unknown; error?: { code?: string; message?: string } } | null;

export function createAccountClient({ base, fetch, tokens }: {
  /** Returns the API base, or throws when this build has none configured. */
  base: () => string;
  fetch: FetchLike;
  tokens: TokenStore;
}) {
  let refreshing: Promise<Tokens | null> | null = null;

  async function send(path: string, { method = 'GET', body, signedIn = false }: RequestOptions, accessToken?: string) {
    let root: string;
    try {
      root = base();
    } catch {
      throw new ApiError(UNAVAILABLE_MESSAGE, { code: 'accounts_unavailable' });
    }
    const headers: Record<string, string> = { Accept: 'application/json', 'x-together-client': 'app' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (signedIn && accessToken) headers.Authorization = `Bearer ${accessToken}`;
    let response;
    try {
      response = await fetch(`${root}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(OFFLINE_MESSAGE, { code: 'offline' });
    }
    const payload = (response.status === 204 ? null : await response.json().catch(() => null)) as Payload;
    return { response, payload };
  }

  function failure(status: number, payload: Payload) {
    return new ApiError(payload?.error?.message || FALLBACK_MESSAGE, { code: payload?.error?.code, status });
  }

  // One refresh at a time: two requests that expire together must not spend the same refresh
  // token twice, because the second spend would be refused and sign the person out.
  function refresh(): Promise<Tokens | null> {
    refreshing ??= (async () => {
      const held = await tokens.read();
      if (!held?.refreshToken) return null;
      const { response, payload } = await send('/auth/refresh', { method: 'POST', body: { refreshToken: held.refreshToken } });
      const fresh = (response.ok ? (payload?.data as Tokens | null) : null) ?? null;
      if (fresh?.token && fresh.refreshToken) {
        await tokens.write({ token: fresh.token, tokenExpiresAt: fresh.tokenExpiresAt, refreshToken: fresh.refreshToken, refreshTokenExpiresAt: fresh.refreshTokenExpiresAt });
        return fresh;
      }
      await tokens.clear();
      return null;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const held = options.signedIn ? await tokens.read() : null;
    if (options.signedIn && !held) throw new ApiError(SIGN_IN_AGAIN_MESSAGE, { code: 'authentication_required', status: 401 });
    let { response, payload } = await send(path, options, held?.token);
    // Only an expired or unknown token is worth a refresh. A wrong password is also a 401, and
    // refreshing for it would rotate the tokens for nothing and retry a request that will fail.
    if (options.signedIn && response.status === 401 && payload?.error?.code === 'authentication_required') {
      const fresh = await refresh();
      if (!fresh) throw new ApiError(SIGN_IN_AGAIN_MESSAGE, { code: 'authentication_required', status: 401 });
      ({ response, payload } = await send(path, options, fresh.token));
    }
    if (!response.ok) throw failure(response.status, payload);
    return (payload?.data ?? null) as T;
  }

  async function keep<T extends { user: AccountUser } & Partial<Tokens>>(data: T): Promise<T> {
    if (data.token && data.refreshToken && data.tokenExpiresAt && data.refreshTokenExpiresAt) {
      await tokens.write({ token: data.token, tokenExpiresAt: data.tokenExpiresAt, refreshToken: data.refreshToken, refreshTokenExpiresAt: data.refreshTokenExpiresAt });
    }
    return data;
  }

  return {
    async register(input: { email: string; username: string; password: string }) {
      const data = await keep(await request<{ user: AccountUser; verificationSent?: boolean } & Tokens>('/auth/register', { method: 'POST', body: input }));
      return { user: data.user, verificationSent: data.verificationSent !== false };
    },
    async login(input: { identifier: string; password: string }) {
      return (await keep(await request<{ user: AccountUser } & Tokens>('/auth/login', { method: 'POST', body: input }))).user;
    },
    async session() {
      if (!await tokens.read()) return null;
      return (await request<{ user: AccountUser }>('/session', { signedIn: true })).user;
    },
    async logout() {
      try {
        await request('/auth/logout', { method: 'POST', signedIn: true });
      } finally {
        // Signing out on this phone always forgets its tokens, even when the service cannot be
        // told, so a lost phone never stays signed in because it happened to be offline.
        await tokens.clear();
      }
    },
    async resendVerification() {
      const result = await request<{ delivered?: boolean }>('/auth/resend-verification', { method: 'POST', body: {}, signedIn: true });
      return result?.delivered !== false;
    },
    async verifyEmail(token: string) {
      return (await request<{ user: AccountUser }>('/auth/verify-email', { method: 'POST', body: { token } })).user;
    },
    async requestRecovery(email: string) {
      await request('/recovery/request', { method: 'POST', body: { email } });
    },
    async confirmRecovery(token: string, password: string) {
      await request('/recovery/confirm', { method: 'POST', body: { token, password } });
      // A new password signs the account out everywhere, this phone included.
      await tokens.clear();
    },
    async deleteAccount(password: string) {
      await request('/account', { method: 'DELETE', body: { password, confirmation: 'DELETE' }, signedIn: true });
      await tokens.clear();
    },
  };
}

export type AccountClient = ReturnType<typeof createAccountClient>;
