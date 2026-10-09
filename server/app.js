import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import rawBody from 'fastify-raw-body';
import { DisabledBillingService } from './billing.js';
import { PlatformError } from './platform.js';
import { bearerTokenFrom } from './security.js';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_COOKIE = 'tl_session';
const APP_CLIENT_HEADER = 'x-together-client';

export async function buildApp({ platform, config, billing = new DisabledBillingService(), store = null, logger = false }) {
  const app = Fastify({ logger, trustProxy: config.trustProxy, bodyLimit: 64 * 1024 });
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(rawBody, { field: 'rawBody', global: false, encoding: false, runFirst: true });
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Together-Client, X-Together-CSRF, X-Together-Image-Name');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      reply.header('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      if (!allowedOrigins.has(origin)) return reply.code(403).send({ error: { code: 'invalid_origin', message: 'This request did not come from the Together Ledger app.' } });
      return reply.code(204).send();
    }
  });
  await app.register(fastifyStatic, { root: join(rootDirectory, 'src'), prefix: '/src/' });
  const indexMarkup = await readFile(join(rootDirectory, 'index.html'), 'utf8');
  const hostedIndexMarkup = indexMarkup
    .replace(
      '<meta name="together-accounts-enabled" content="false" />',
      '<meta name="together-accounts-enabled" content="true" />',
    )
    .replace(
      /<meta name="together-api-origin" content="[^"]*" \/>/,
      `<meta name="together-api-origin" content="${config.API_ORIGIN}" />`,
    );
  const allowedOrigins = new Set([
    config.PUBLIC_ORIGIN,
    config.API_ORIGIN,
    config.ACCOUNT_ORIGIN,
    ...config.appOrigins,
  ].filter(Boolean));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PlatformError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    if (error.validation) return reply.code(400).send({ error: { code: 'invalid_input', message: 'The request is not valid.' } });
    if (error.statusCode === 429) return reply.code(429).send({ error: { code: 'rate_limit_exceeded', message: 'Too many requests. Wait and try again.' } });
    request.log.error({ err: { name: error.name, message: error.message } }, 'request failed');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'The service could not complete the request.' } });
  });

  function cookieOptions() {
    return { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: config.SESSION_HOURS * 60 * 60 };
  }

  function requireOrigin(request) {
    if (!allowedOrigins.has(request.headers.origin)) throw new PlatformError(403, 'invalid_origin', 'This request did not come from the Together Ledger app.');
  }

  function presentedToken(request) {
    return bearerTokenFrom(request.headers.authorization);
  }

  // The origin check and the CSRF header both exist to stop a hostile page from spending a
  // cookie the browser attaches on its own. A phone has neither a cookie nor a page, so it asks
  // for a token with this header and carries one from then on. A browser cannot borrow the claim:
  // a custom header or an Authorization header makes a cross-origin request preflight, and the
  // OPTIONS handler above refuses an origin that is not ours.
  //
  // This says only which credential the caller wants issued. It is never what decides whether a
  // check applies: asking for a token is a claim, and a claim is not a credential.
  function asksForToken(request) {
    return String(request.headers[APP_CLIENT_HEADER] || '').trim().toLowerCase() === 'app';
  }

  // A client with no browser has no origin to send, so a token it already holds stands in for
  // one. Registering and signing in are the two places that have no token yet, and they say so
  // explicitly rather than letting every caller opt out of the check by claiming to be an app.
  function accountOriginFor(request, { issuingToken = false } = {}) {
    if (issuingToken || presentedToken(request)) return config.ACCOUNT_ORIGIN || config.PUBLIC_ORIGIN;
    requireOrigin(request);
    return request.headers.origin;
  }

  async function authenticate(request) {
    const presented = presentedToken(request);
    if (presented) {
      const holder = await platform.tokenHolder(presented);
      if (!holder) throw new PlatformError(401, 'authentication_required', 'Sign in to continue.');
      request.auth = holder;
      return;
    }
    const session = await platform.session(request.cookies[SESSION_COOKIE]);
    if (!session) throw new PlatformError(401, 'authentication_required', 'Sign in to continue.');
    request.auth = session;
  }

  async function protectMutation(request) {
    if (presentedToken(request)) return authenticate(request);
    requireOrigin(request);
    await authenticate(request);
    if (request.headers['x-together-csrf'] !== request.auth.csrfToken) throw new PlatformError(403, 'invalid_csrf', 'Refresh the page and try again.');
  }

  // Stripe is the web's way to pay, and only the web's; the phones pay through Apple and Google
  // (#267). A phone app that opens a web checkout is refused by both stores (Apple 3.1.1 and
  // 3.1.3), so a caller holding the phone's credential is refused here too, whatever its client
  // code does (#268). A bearer token is only ever issued to the app; the browser signs in with a
  // cookie and is untouched by this.
  async function keepStripeOffThePhone(request) {
    if (request.auth?.bearer) throw new PlatformError(403, 'not_from_the_app', 'A web checkout is not opened from the app.');
  }
  const stripeSession = [protectMutation, keepStripeOffThePhone];

  function setSession(reply, session) {
    reply.setCookie(SESSION_COOKIE, session.rawToken, cookieOptions());
  }

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await platform.ready();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(hostedIndexMarkup));

  app.post('/api/v1/auth/register', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const wantsToken = asksForToken(request);
    const result = await platform.register(request.body || {}, accountOriginFor(request, { issuingToken: wantsToken }), { issueSession: !wantsToken });
    if (wantsToken) return reply.code(201).send({ data: { user: result.user, verificationSent: result.verificationSent, ...await platform.issueTokens(result.user.id) } });
    setSession(reply, result.session);
    return reply.code(201).send({ data: { user: result.user, csrfToken: result.session.csrfToken, verificationSent: result.verificationSent } });
  });

  // The single-use token in the body is the credential here, and nothing ambient is spent or
  // issued: no cookie is read and none is set. So the origin check guards nothing for a phone,
  // which has no origin to send, and it is skipped for a client that says it is the app, as
  // signing in does. A browser still has to be ours (TL-M-05, #180).
  app.post('/api/v1/auth/verify-email', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request) => {
    if (!asksForToken(request)) requireOrigin(request);
    return { data: { user: await platform.verifyEmail(request.body?.token) } };
  });

  app.post('/api/v1/auth/resend-verification', { preHandler: protectMutation, config: { rateLimit: { max: 3, timeWindow: '30 minutes' } } }, async (request, reply) => {
    const delivered = await platform.resendVerification(request.auth.userId, accountOriginFor(request));
    return reply.code(202).send({ data: { accepted: true, delivered: delivered !== false } });
  });

  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    // Signing in is one of the two places a token can be born, so the claim has to be honoured
    // here or a phone could never get one. It costs nothing: a client asking for a token is not
    // issued a cookie, so there is no ambient session for a hostile page to plant, and the
    // password check and rate limit that actually guard this route are untouched.
    const wantsToken = asksForToken(request);
    if (!wantsToken) requireOrigin(request);
    const result = await platform.login(request.body || {}, { issueSession: !wantsToken });
    if (wantsToken) return { data: { user: result.user, ...await platform.issueTokens(result.user.id) } };
    setSession(reply, result.session);
    return { data: { user: result.user, csrfToken: result.session.csrfToken } };
  });

  // Google and Apple (#214). Like signing in with a password, these are places a credential is
  // born, so a phone's claim to want a token is honoured and a browser must be ours. The ID token
  // in the body is the credential; the reply is the same cookie + CSRF pair, or token pair, that
  // a password login gives, so nothing downstream can tell how someone signed in.
  async function socialReply(request, reply, signIn) {
    const wantsToken = asksForToken(request);
    if (!wantsToken) requireOrigin(request);
    const result = await signIn({ issueSession: !wantsToken });
    if (wantsToken) return { data: { user: result.user, ...await platform.issueTokens(result.user.id) } };
    setSession(reply, result.session);
    return { data: { user: result.user, csrfToken: result.session.csrfToken } };
  }

  for (const provider of ['google', 'apple']) {
    app.post(`/api/v1/auth/${provider}`, { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => (
      socialReply(request, reply, (options) => platform.socialSignIn(provider, request.body || {}, options))
    ));
  }

  // The answer to `link_required`: the same ID token, with the password of the account that
  // already uses its email. It shares login's rate limit, since it is a password check too.
  app.post('/api/v1/auth/link', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const provider = request.body?.provider;
    if (provider !== 'google' && provider !== 'apple') throw new PlatformError(400, 'invalid_input', 'Choose Google or Apple.');
    return socialReply(request, reply, (options) => platform.linkIdentity(provider, request.body || {}, options));
  });

  // Apple's server-to-server notifications (#250), set on the com.togetherledger.ledger App ID as
  // https://api.together-ledger.com/api/v1/auth/apple/notifications. Apple's servers send them, so
  // there is no origin, cookie or token to check: the signed payload is the credential, verified
  // against Apple's keys. An account deleted this way goes through the same billing check as
  // Delete account.
  app.post('/api/v1/auth/apple/notifications', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const payload = request.body?.payload;
    if (typeof payload !== 'string') throw new PlatformError(400, 'invalid_input', 'The request is not valid.');
    const accepted = await platform.handleAppleNotification(payload, {
      deleteAccount: async (userId) => {
        await billing.assertAccountDeletable(userId);
        await platform.deleteAccount(userId, null);
      },
    });
    if (!accepted) throw new PlatformError(400, 'invalid_token', 'The notification could not be verified.');
    return reply.code(200).send({ data: { accepted: true } });
  });

  // Rotation, not renewal: the refresh token presented here is spent, and the reply carries a
  // fresh pair. Nothing is read from the URL, so neither token reaches a log or a history entry.
  app.post('/api/v1/auth/refresh', { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } }, async (request) => ({
    data: await platform.refreshTokens(request.body?.refreshToken),
  }));

  app.post('/api/v1/auth/logout', { preHandler: protectMutation }, async (request, reply) => {
    const presented = presentedToken(request);
    if (presented) {
      await platform.revokeToken(presented);
      return reply.code(204).send();
    }
    await platform.logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, cookieOptions());
    return reply.code(204).send();
  });

  app.get('/api/v1/session', { preHandler: authenticate }, async (request) => (
    request.auth.bearer
      ? { data: { user: request.auth.user } }
      : { data: { user: request.auth.user, csrfToken: request.auth.csrfToken } }
  ));

  app.get('/api/v1/journeys/:journeyId/billing', { preHandler: authenticate }, async (request) => ({ data: await billing.status(request.auth.userId, request.params.journeyId) }));
  app.post('/api/v1/journeys/:journeyId/billing/checkout-sessions', { preHandler: stripeSession, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const session = await billing.createCheckoutSession(request.auth.userId, request.params.journeyId, request.body || {});
    return reply.code(201).send({ data: session });
  });
  app.post('/api/v1/journeys/:journeyId/billing/portal-sessions', { preHandler: stripeSession, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const session = await billing.createPortalSession(request.auth.userId, request.params.journeyId);
    return reply.code(201).send({ data: session });
  });
  app.get('/api/v1/journeys/:journeyId/moments/:momentId/image-slots', { preHandler: authenticate }, async (request) => ({ data: { slots: await platform.imageSlots(request.auth.userId, request.params.journeyId, request.params.momentId) } }));
  app.post('/api/v1/journeys/:journeyId/moments/:momentId/image-slots/checkout-sessions', { preHandler: stripeSession, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => reply.code(201).send({ data: await billing.createImageCheckoutSession(request.auth.userId, request.params.journeyId, request.params.momentId, request.body || {}) }));
  app.post('/api/v1/journeys/:journeyId/moments/:momentId/location-slots/checkout-sessions', { preHandler: stripeSession, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => reply.code(201).send({ data: await billing.createLocationCheckoutSession(request.auth.userId, request.params.journeyId, request.params.momentId, request.body || {}) }));
  // What a phone sends to Apple or Google when it starts a purchase (#269). Created the first time
  // and the same ever after, so it is a POST that is safe to repeat.
  app.post('/api/v1/journeys/:journeyId/billing/store-identity', { preHandler: protectMutation, config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } }, async (request) => ({ data: await platform.storePurchaseIdentity(request.auth.userId, request.params.journeyId) }));
  // A purchase made in the App Store or Google Play, checked here before it becomes anything
  // (#272, docs/STORE_PURCHASES.md). 201 when this request granted it, 200 when it had been
  // granted already: the same transaction twice grants once, so a phone can always send it again.
  function storeService() {
    if (!store) throw new PlatformError(503, 'store_unavailable', 'Store purchases can\u2019t be checked right now. Your purchase is safe with the store, and it will be added when Together Ledger can check it.', { retryable: true });
    return store;
  }
  const storePurchase = (verify) => async (request, reply) => {
    const result = await verify(storeService(), request.auth.userId, request.body || {});
    return reply.code(result.granted ? 201 : 200).send({ data: result });
  };
  app.post('/api/v1/billing/store-purchases/apple', { preHandler: protectMutation, config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } }, storePurchase((service, userId, body) => service.verifyApple(userId, body)));
  app.post('/api/v1/billing/store-purchases/google', { preHandler: protectMutation, config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } }, storePurchase((service, userId, body) => service.verifyGoogle(userId, body)));
  // What the App Store says about a purchase afterwards (#273): App Store Server Notifications V2,
  // set in App Store Connect as both the Production and the Sandbox URL. Apple's servers send them,
  // so there is no origin, cookie or token to check: the signed payload is the credential, checked
  // against APPLE_ROOT_CERTIFICATES exactly as a purchase is. Sign in with Apple's own
  // notifications are another thing, at /api/v1/auth/apple/notifications (#250). Apple sends again
  // until it hears a 200, and a notification received twice changes nothing the second time.
  app.post('/api/v1/billing/store-notifications/apple', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    await storeService().handleAppleNotification(request.body || {});
    return reply.code(200).send({ data: { received: true } });
  });
  app.post('/api/v1/billing/webhooks/stripe', { config: { rawBody: true, rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const result = await billing.handleWebhook(request.rawBody, request.headers['stripe-signature']);
    return reply.code(200).send(result);
  });

  // Someone who has forgotten their password has no token yet, so a phone asking for a recovery
  // link is one of the places a credential is still to come, like registering. The link it sends
  // goes to the account origin, never to an address the caller chose.
  app.post('/api/v1/recovery/request', { config: { rateLimit: { max: 5, timeWindow: '30 minutes' } } }, async (request, reply) => {
    await platform.requestRecovery(request.body?.email, accountOriginFor(request, { issuingToken: asksForToken(request) }));
    return reply.code(202).send({ data: { accepted: true } });
  });

  // As with verifying an email, the recovery token in the body is the credential, and a new
  // password revokes every session and token the account holds, phones included.
  app.post('/api/v1/recovery/confirm', { config: { rateLimit: { max: 10, timeWindow: '30 minutes' } } }, async (request, reply) => {
    if (!asksForToken(request)) requireOrigin(request);
    await platform.confirmRecovery(request.body || {});
    reply.clearCookie(SESSION_COOKIE, cookieOptions());
    return { data: { passwordChanged: true } };
  });

  // Only ever the signed-in person's own name: nothing in the request says whose it is. Limited,
  // because each change is written into every journey the person is in.
  app.patch('/api/v1/account', { preHandler: protectMutation, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request) => ({
    data: { user: await platform.changeDisplayName(request.auth.userId, request.body || {}) },
  }));

  app.delete('/api/v1/account', { preHandler: protectMutation }, async (request, reply) => {
    if (request.body?.confirmation !== 'DELETE') throw new PlatformError(400, 'confirmation_required', 'Type DELETE to confirm account deletion.');
    await billing.assertAccountDeletable(request.auth.userId);
    // deleteAccount logs the `account deleted` line a restore from backup relies on.
    await platform.deleteAccount(request.auth.userId, request.body?.password);
    reply.clearCookie(SESSION_COOKIE, cookieOptions());
    return reply.code(204).send();
  });

  app.get('/api/v1/journeys', { preHandler: authenticate }, async (request) => ({ data: { journeys: await platform.listJourneys(request.auth.userId) } }));
  app.post('/api/v1/journeys', { preHandler: protectMutation }, async (request, reply) => reply.code(201).send({ data: { journey: await platform.createJourney(request.auth.userId, request.body || {}) } }));
  app.patch('/api/v1/journeys/:journeyId', { preHandler: protectMutation }, async (request) => ({ data: { journey: await platform.updateJourney(request.auth.userId, request.params.journeyId, request.body || {}) } }));
  app.patch('/api/v1/journeys/:journeyId/unpaid-capacity', { preHandler: protectMutation }, async (request) => ({ data: { capacity: await platform.setRestOrder(request.auth.userId, request.params.journeyId, request.body || {}) } }));
  app.post('/api/v1/journeys/:journeyId/grace-requests', { preHandler: protectMutation }, async (request, reply) => reply.code(201).send({ data: { capacity: await platform.requestMoreGrace(request.auth.userId, request.params.journeyId) } }));
  // `extras` says which paid extras a moment can use here, so a phone offers only those (#340).
  app.get('/api/v1/journeys/:journeyId/snapshot', { preHandler: authenticate }, async (request) => ({
    data: { ...await platform.snapshot(request.auth.userId, request.params.journeyId, request.query?.after), extras: { place: billing.locationExtrasEnabled?.() === true } },
  }));
  app.get('/api/v1/journeys/:journeyId/events', { preHandler: authenticate }, async (request) => {
    const snapshot = await platform.snapshot(request.auth.userId, request.params.journeyId, request.query?.after);
    return { data: { events: snapshot.events } };
  });

  // Proposing is not adding. Nothing reaches the proposed person until every journeyer agrees,
  // so this answers with what happened rather than always claiming an invitation went out.
  app.post('/api/v1/journeys/:journeyId/invitations', { preHandler: protectMutation }, async (request, reply) => {
    const result = await platform.proposeInvitation(request.auth.userId, request.params.journeyId, request.body?.email, request.body?.note, accountOriginFor(request));
    return reply.code(202).send({ data: result });
  });
  app.post('/api/v1/journeys/:journeyId/invite-proposals/:proposalId/decision', { preHandler: protectMutation }, async (request, reply) => {
    const result = await platform.decideInviteProposal(request.auth.userId, request.params.journeyId, request.params.proposalId, request.body?.decision, accountOriginFor(request));
    return reply.code(202).send({ data: result });
  });
  app.post('/api/v1/journeys/:journeyId/invite-proposals/:proposalId/send', { preHandler: protectMutation }, async (request, reply) => {
    await platform.sendAgreedProposal(request.auth.userId, request.params.journeyId, request.params.proposalId, accountOriginFor(request));
    return reply.code(202).send({ data: { invitationSent: true } });
  });
  app.delete('/api/v1/journeys/:journeyId/invite-proposals/:proposalId', { preHandler: protectMutation }, async (request, reply) => {
    await platform.withdrawInviteProposal(request.auth.userId, request.params.journeyId, request.params.proposalId);
    return reply.code(204).send();
  });
  // A sent invitation can be withdrawn by whoever asked or the owner, and one that ran out can be
  // sent again by whoever asked while the agreement's 30 days last (#347).
  app.delete('/api/v1/journeys/:journeyId/invitations/:invitationId', { preHandler: protectMutation }, async (request, reply) => {
    await platform.withdrawInvitation(request.auth.userId, request.params.journeyId, request.params.invitationId);
    return reply.code(204).send();
  });
  app.post('/api/v1/journeys/:journeyId/invitations/:invitationId/send-again', { preHandler: protectMutation }, async (request, reply) => {
    await platform.sendInvitationAgain(request.auth.userId, request.params.journeyId, request.params.invitationId, accountOriginFor(request));
    return reply.code(202).send({ data: { invitationSent: true } });
  });
  // The token travels in the body, which the log never records (issue #208). The path form below
  // stays for clients that haven't updated; server/log-options.js masks its token in the log.
  app.post('/api/v1/invitations/accept', { preHandler: protectMutation }, async (request) => {
    const token = typeof request.body?.token === 'string' ? request.body.token : '';
    return { data: { journeyId: await platform.acceptInvitation(request.auth.userId, token) } };
  });
  app.post('/api/v1/invitations/:token/accept', { preHandler: protectMutation }, async (request) => ({ data: { journeyId: await platform.acceptInvitation(request.auth.userId, request.params.token) } }));
  app.delete('/api/v1/journeys/:journeyId/members/:userId', { preHandler: protectMutation }, async (request, reply) => {
    await platform.removeMember(request.auth.userId, request.params.journeyId, request.params.userId);
    return reply.code(204).send();
  });
  app.post('/api/v1/journeys/:journeyId/ownership', { preHandler: protectMutation }, async (request, reply) => {
    await platform.transferOwnership(request.auth.userId, request.params.journeyId, request.body?.userId);
    return reply.code(204).send();
  });

  app.post('/api/v1/journeys/:journeyId/expenses', { preHandler: protectMutation }, async (request, reply) => reply.code(201).send({ data: { expense: await platform.createExpense(request.auth.userId, request.params.journeyId, request.body || {}) } }));
  app.patch('/api/v1/journeys/:journeyId/expenses/:expenseId', { preHandler: protectMutation }, async (request) => ({ data: { expense: await platform.mutateExpense(request.auth.userId, request.params.journeyId, request.params.expenseId, request.body || {}) } }));
  app.delete('/api/v1/journeys/:journeyId/expenses/:expenseId', { preHandler: protectMutation }, async (request, reply) => {
    await platform.mutateExpense(request.auth.userId, request.params.journeyId, request.params.expenseId, request.body || {}, { remove: true });
    return reply.code(204).send();
  });

  app.post('/api/v1/journeys/:journeyId/moments', { preHandler: protectMutation }, async (request, reply) => {
    if (config.momentLocationBillingEnabled && Array.isArray(request.body?.locations) && request.body.locations.length > 1) throw new PlatformError(409, 'location_payment_required', 'Hold the first place, then add another through its monthly place add-on.');
    // A resend of a moment already held (#352) answers 200 with that moment; a new one is 201.
    const { moment, replayed } = await platform.holdMoment(request.auth.userId, request.params.journeyId, request.body || {});
    return reply.code(replayed ? 200 : 201).send({ data: { moment } });
  });
  app.patch('/api/v1/journeys/:journeyId/moments/:momentId', { preHandler: protectMutation }, async (request) => {
    if (config.momentLocationBillingEnabled) await billing.assertLocationCapacity(request.auth.userId, request.params.journeyId, request.params.momentId, Array.isArray(request.body?.locations) ? request.body.locations.length : 0);
    return { data: { moment: await platform.mutateMoment(request.auth.userId, request.params.journeyId, request.params.momentId, request.body || {}) } };
  });
  app.delete('/api/v1/journeys/:journeyId/moments/:momentId', { preHandler: protectMutation }, async (request, reply) => {
    await platform.mutateMoment(request.auth.userId, request.params.journeyId, request.params.momentId, request.body || {}, { remove: true });
    return reply.code(204).send();
  });
  app.post('/api/v1/journeys/:journeyId/moments/:momentId/images', { preHandler: protectMutation, bodyLimit: 25 * 1024 * 1024 }, async (request, reply) => {
    // A paid slot is checked and spent in one statement inside the upload, whether the web or a
    // store paid for it (#272).
    const paidSlotId = request.query?.paidSlotId || null;
    return reply.code(201).send({ data: { image: await platform.uploadMomentImage(request.auth.userId, request.params.journeyId, request.params.momentId, request.headers['content-type'], request.body, paidSlotId, request.headers['x-together-image-name']) } });
  });
  app.get('/api/v1/journeys/:journeyId/moments/:momentId/images/:imageId', { preHandler: authenticate }, async (request, reply) => {
    const image = await platform.momentImage(request.auth.userId, request.params.journeyId, request.params.momentId, request.params.imageId);
    return reply.header('Cache-Control', 'private, max-age=300').type(image.content_type).send(image.bytes);
  });
  app.delete('/api/v1/journeys/:journeyId/moments/:momentId/images/:imageId', { preHandler: protectMutation }, async (request, reply) => {
    await platform.deleteMomentImage(request.auth.userId, request.params.journeyId, request.params.momentId, request.params.imageId);
    return reply.code(204).send();
  });

  app.post('/api/v1/journeys/:journeyId/concerns', { preHandler: protectMutation }, async (request, reply) => reply.code(201).send({ data: { concern: await platform.createConcern(request.auth.userId, request.params.journeyId, request.body || {}) } }));
  app.patch('/api/v1/journeys/:journeyId/concerns/:concernId', { preHandler: protectMutation }, async (request) => ({ data: { concern: await platform.mutateConcern(request.auth.userId, request.params.journeyId, request.params.concernId, request.body || {}) } }));
  app.delete('/api/v1/journeys/:journeyId/concerns/:concernId', { preHandler: protectMutation }, async (request, reply) => {
    await platform.mutateConcern(request.auth.userId, request.params.journeyId, request.params.concernId, request.body || {}, { remove: true });
    return reply.code(204).send();
  });
  app.patch('/api/v1/journeys/:journeyId/milestones/:key', { preHandler: protectMutation }, async (request) => ({ data: { milestone: await platform.setMilestone(request.auth.userId, request.params.journeyId, request.params.key, request.body?.completed) } }));

  return app;
}
