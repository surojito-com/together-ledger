/**
 * The phone's client for the account (TL-M-05, #180) and the journey it shows (TL-M-07, #182), against the bearer-token path from TL-M-04 (#179).
 *
 * Every request says it is the app (`x-together-client: app`), so the server issues tokens rather
 * than a cookie. A signed-in request carries its access token. When that token has expired, the
 * refresh token is spent once for a fresh pair (the server rotates, so a refresh token is never
 * reused) and the request is retried once. Only a refusal clears the stored tokens and asks the
 * person to sign in again: `/auth/refresh` answering 401 `invalid_token`. Anything else (no
 * connection, a 5xx, a 429, a reply that isn't the service's JSON) keeps them, and is reported
 * as the service being out of reach, never as being signed out (#353). If a renewal's reply was
 * lost, the phone still holds the spent refresh token; the server answers it again with a fresh
 * pair as long as nobody has used the lost one (server/platform.js, refreshTokens).
 *
 * The two situations the web client keeps apart stay apart here: `offline` (the service could
 * not be reached) and `accounts_unavailable` (this build has no service to reach at all). A
 * renewal the service answered without a pair is `unreachable`, in the offline words.
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
  /** What the service added to a refusal, such as whether a store purchase is worth sending again (`retryable`). */
  details: Record<string, unknown> | null;
  constructor(message: string, { code = 'request_failed', status = 0, details = null }: { code?: string; status?: number; details?: Record<string, unknown> | null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
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

type Payload = { data?: unknown; error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null;

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
    const details = payload?.error?.details;
    return new ApiError(payload?.error?.message || FALLBACK_MESSAGE, { code: payload?.error?.code, status, details: details && typeof details === 'object' ? details : null });
  }

  // One refresh at a time: two requests that expire together must not spend the same refresh
  // token twice. Resolves null only when the service refused the tokens; throws when it could
  // not be asked or did not answer with a pair, and the tokens stay as they were.
  function refresh(): Promise<Tokens | null> {
    refreshing ??= (async () => {
      const held = await tokens.read();
      if (!held?.refreshToken) return null;
      const { response, payload } = await send('/auth/refresh', { method: 'POST', body: { refreshToken: held.refreshToken } });
      if (response.status === 401 && payload?.error?.code === 'invalid_token') {
        await tokens.clear();
        return null;
      }
      const fresh = (response.ok ? (payload?.data as Tokens | null) : null) ?? null;
      if (fresh?.token && fresh.refreshToken && fresh.tokenExpiresAt && fresh.refreshTokenExpiresAt) {
        await tokens.write({ token: fresh.token, tokenExpiresAt: fresh.tokenExpiresAt, refreshToken: fresh.refreshToken, refreshTokenExpiresAt: fresh.refreshTokenExpiresAt });
        return fresh;
      }
      throw new ApiError(OFFLINE_MESSAGE, { code: 'unreachable', status: response.status });
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
    /** The journeys this account belongs to, most recently changed first (TL-M-07, #182). */
    async journeys<J>() {
      return (await request<{ journeys: J[] }>('/journeys', { signedIn: true }))?.journeys ?? [];
    },
    /** Begin a journey (#333). The account that creates it owns it. */
    async createJourney<J>(journey: object) {
      return (await request<{ journey: J }>('/journeys', { method: 'POST', body: journey, signedIn: true })).journey;
    },
    async snapshot<S>(journeyId: string) {
      return request<S>(`/journeys/${encodeURIComponent(journeyId)}/snapshot`, { signedIn: true });
    },
    /** Hold a new moment (TL-M-08, #183). */
    async createMoment<M>(journeyId: string, moment: object) {
      return (await request<{ moment: M }>(`/journeys/${encodeURIComponent(journeyId)}/moments`, { method: 'POST', body: moment, signedIn: true })).moment;
    },
    /** Change a moment, from the version it was read at; a newer one elsewhere is a conflict. */
    async updateMoment<M>(journeyId: string, momentId: string, moment: object) {
      return (await request<{ moment: M }>(`/journeys/${encodeURIComponent(journeyId)}/moments/${encodeURIComponent(momentId)}`, { method: 'PATCH', body: moment, signedIn: true })).moment;
    },
    async deleteMoment(journeyId: string, momentId: string, version: number) {
      await request(`/journeys/${encodeURIComponent(journeyId)}/moments/${encodeURIComponent(momentId)}`, { method: 'DELETE', body: { version }, signedIn: true });
    },
    /**
     * Where a moment's photo is, with the access token the image loader has to send. A token
     * about to lapse is refreshed first, because the loader cannot retry the way request() does.
     */
    async imageSource(journeyId: string, momentId: string, imageId: string, now = Date.now()) {
      let held = await tokens.read();
      if (!held) throw new ApiError(SIGN_IN_AGAIN_MESSAGE, { code: 'authentication_required', status: 401 });
      if (Date.parse(held.tokenExpiresAt) - now < 60_000) held = await refresh();
      if (!held) throw new ApiError(SIGN_IN_AGAIN_MESSAGE, { code: 'authentication_required', status: 401 });
      let root: string;
      try {
        root = base();
      } catch {
        throw new ApiError(UNAVAILABLE_MESSAGE, { code: 'accounts_unavailable' });
      }
      return {
        uri: `${root}/journeys/${encodeURIComponent(journeyId)}/moments/${encodeURIComponent(momentId)}/images/${encodeURIComponent(imageId)}`,
        headers: { Authorization: `Bearer ${held.token}`, 'x-together-client': 'app' },
      };
    },
    /** The name journeyers see (#253); the private username never changes. */
    async changeDisplayName(displayName: string) {
      return (await request<{ user: AccountUser }>('/account', { method: 'PATCH', body: { displayName }, signedIn: true })).user;
    },
    /**
     * Journey settings (TL-M-09, #184). Proposing is not adding: nothing reaches the person until
     * everyone already in the journey agrees (migration 022), so each answer says what happened.
     */
    async proposeInvitation(journeyId: string, input: { email: string; note?: string }) {
      return request<{ invitationSent?: boolean }>(`/journeys/${encodeURIComponent(journeyId)}/invitations`, { method: 'POST', body: input, signedIn: true });
    },
    async decideProposal(journeyId: string, proposalId: string, decision: 'agree' | 'decline') {
      return request<{ invitationSent?: boolean }>(`/journeys/${encodeURIComponent(journeyId)}/invite-proposals/${encodeURIComponent(proposalId)}/decision`, { method: 'POST', body: { decision }, signedIn: true });
    },
    async withdrawProposal(journeyId: string, proposalId: string) {
      await request(`/journeys/${encodeURIComponent(journeyId)}/invite-proposals/${encodeURIComponent(proposalId)}`, { method: 'DELETE', body: {}, signedIn: true });
    },
    async removeMember(journeyId: string, userId: string) {
      await request(`/journeys/${encodeURIComponent(journeyId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE', body: {}, signedIn: true });
    },
    async transferOwnership(journeyId: string, userId: string) {
      await request(`/journeys/${encodeURIComponent(journeyId)}/ownership`, { method: 'POST', body: { userId }, signedIn: true });
    },
    async setRestOrder(journeyId: string, restOrder: string[]) {
      return request(`/journeys/${encodeURIComponent(journeyId)}/unpaid-capacity`, { method: 'PATCH', body: { restOrder }, signedIn: true });
    },
    async requestMoreGrace(journeyId: string) {
      return request(`/journeys/${encodeURIComponent(journeyId)}/grace-requests`, { method: 'POST', body: {}, signedIn: true });
    },
    /** Where this journey's paid capacity stands. The phone never starts a web purchase; it sells through the App Store and Google Play (#267). */
    async billingStatus<B>(journeyId: string) {
      return request<B>(`/journeys/${encodeURIComponent(journeyId)}/billing`, { signedIn: true });
    },
    /**
     * What Apple or Google must carry through a purchase for this journey, so it comes back tied
     * to this account (#269). Signed in only: nothing is bought while signed out. Use it through
     * purchaseOptions() in src/billing/store-purchase.ts, never directly.
     */
    async storePurchaseIdentity(journeyId: string) {
      return request<{ appAccountToken: string; obfuscatedAccountId: string; obfuscatedProfileId: string }>(`/journeys/${encodeURIComponent(journeyId)}/billing/store-identity`, { method: 'POST', body: {}, signedIn: true });
    },
    /**
     * A purchase the App Store or Google Play has just made, sent for our server to check and
     * honour (#272, docs/STORE_PURCHASES.md). Nothing is granted on the phone's word. Use them
     * through settleStorePurchase() in src/billing/store-purchase.ts, which decides from the
     * answer whether the store is told the purchase is finished.
     */
    async sendApplePurchase<R>(body: { signedTransaction: string; momentId?: string }) {
      return request<R>('/billing/store-purchases/apple', { method: 'POST', body, signedIn: true });
    },
    async sendGooglePurchase<R>(body: { productId: string; purchaseToken: string; momentId?: string; packageName?: string }) {
      return request<R>('/billing/store-purchases/google', { method: 'POST', body, signedIn: true });
    },
    async createConcern(journeyId: string, concern: { title: string; detail: string; status: string }) {
      await request(`/journeys/${encodeURIComponent(journeyId)}/concerns`, { method: 'POST', body: concern, signedIn: true });
    },
    /** From the version it was read at; a newer one elsewhere is a conflict. */
    async updateConcern(journeyId: string, concernId: string, concern: { title: string; detail: string; status: string; version: number }) {
      await request(`/journeys/${encodeURIComponent(journeyId)}/concerns/${encodeURIComponent(concernId)}`, { method: 'PATCH', body: concern, signedIn: true });
    },
    async deleteConcern(journeyId: string, concernId: string, version: number) {
      await request(`/journeys/${encodeURIComponent(journeyId)}/concerns/${encodeURIComponent(concernId)}`, { method: 'DELETE', body: { version }, signedIn: true });
    },
    async deleteAccount(password: string) {
      await request('/account', { method: 'DELETE', body: { password, confirmation: 'DELETE' }, signedIn: true });
      await tokens.clear();
    },
  };
}

export type AccountClient = ReturnType<typeof createAccountClient>;
