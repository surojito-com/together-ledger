import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { PlatformError } from './platform.js';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_COOKIE = 'tl_session';

export async function buildApp({ platform, config, logger = false }) {
  const app = Fastify({ logger, trustProxy: config.trustProxy, bodyLimit: 64 * 1024 });
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Together-CSRF');
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
  const hostedIndexMarkup = indexMarkup.replace(
    '<meta name="together-accounts-enabled" content="false" />',
    '<meta name="together-accounts-enabled" content="true" />',
  );
  const allowedOrigins = new Set([config.PUBLIC_ORIGIN, config.API_ORIGIN].filter(Boolean));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PlatformError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
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

  async function authenticate(request) {
    const session = await platform.session(request.cookies[SESSION_COOKIE]);
    if (!session) throw new PlatformError(401, 'authentication_required', 'Sign in to continue.');
    request.auth = session;
  }

  async function protectMutation(request) {
    requireOrigin(request);
    await authenticate(request);
    if (request.headers['x-together-csrf'] !== request.auth.csrfToken) throw new PlatformError(403, 'invalid_csrf', 'Refresh the page and try again.');
  }

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
    requireOrigin(request);
    const result = await platform.register(request.body || {});
    setSession(reply, result.session);
    return reply.code(201).send({ data: { user: result.user, csrfToken: result.session.csrfToken, verificationSent: result.verificationSent } });
  });

  app.post('/api/v1/auth/verify-email', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request) => {
    requireOrigin(request);
    return { data: { user: await platform.verifyEmail(request.body?.token) } };
  });

  app.post('/api/v1/auth/resend-verification', { preHandler: protectMutation, config: { rateLimit: { max: 3, timeWindow: '30 minutes' } } }, async (request, reply) => {
    const delivered = await platform.resendVerification(request.auth.userId);
    return reply.code(202).send({ data: { accepted: true, delivered: delivered !== false } });
  });

  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    requireOrigin(request);
    const result = await platform.login(request.body || {});
    setSession(reply, result.session);
    return { data: { user: result.user, csrfToken: result.session.csrfToken } };
  });

  app.post('/api/v1/auth/logout', { preHandler: protectMutation }, async (request, reply) => {
    await platform.logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, cookieOptions());
    return reply.code(204).send();
  });

  app.get('/api/v1/session', { preHandler: authenticate }, async (request) => ({ data: { user: request.auth.user, csrfToken: request.auth.csrfToken } }));

  app.post('/api/v1/recovery/request', { config: { rateLimit: { max: 5, timeWindow: '30 minutes' } } }, async (request, reply) => {
    requireOrigin(request);
    await platform.requestRecovery(request.body?.email);
    return reply.code(202).send({ data: { accepted: true } });
  });

  app.post('/api/v1/recovery/confirm', { config: { rateLimit: { max: 10, timeWindow: '30 minutes' } } }, async (request, reply) => {
    requireOrigin(request);
    await platform.confirmRecovery(request.body || {});
    reply.clearCookie(SESSION_COOKIE, cookieOptions());
    return { data: { passwordChanged: true } };
  });

  app.delete('/api/v1/account', { preHandler: protectMutation }, async (request, reply) => {
    if (request.body?.confirmation !== 'DELETE') throw new PlatformError(400, 'confirmation_required', 'Type DELETE to confirm account deletion.');
    await platform.deleteAccount(request.auth.userId, request.body?.password);
    reply.clearCookie(SESSION_COOKIE, cookieOptions());
    return reply.code(204).send();
  });

  app.get('/api/v1/journeys', { preHandler: authenticate }, async (request) => ({ data: { journeys: await platform.listJourneys(request.auth.userId) } }));
  app.post('/api/v1/journeys', { preHandler: protectMutation }, async (request, reply) => reply.code(201).send({ data: { journey: await platform.createJourney(request.auth.userId, request.body || {}) } }));
  app.patch('/api/v1/journeys/:journeyId', { preHandler: protectMutation }, async (request) => ({ data: { journey: await platform.updateJourney(request.auth.userId, request.params.journeyId, request.body || {}) } }));
  app.get('/api/v1/journeys/:journeyId/snapshot', { preHandler: authenticate }, async (request) => ({ data: await platform.snapshot(request.auth.userId, request.params.journeyId, request.query?.after) }));
  app.get('/api/v1/journeys/:journeyId/events', { preHandler: authenticate }, async (request) => {
    const snapshot = await platform.snapshot(request.auth.userId, request.params.journeyId, request.query?.after);
    return { data: { events: snapshot.events } };
  });

  app.post('/api/v1/journeys/:journeyId/invitations', { preHandler: protectMutation }, async (request, reply) => {
    await platform.createInvitation(request.auth.userId, request.params.journeyId, request.body?.email);
    return reply.code(202).send({ data: { invitationSent: true } });
  });
  app.post('/api/v1/invitations/:token/accept', { preHandler: protectMutation }, async (request) => ({ data: { journeyId: await platform.acceptInvitation(request.auth.userId, request.params.token) } }));
  app.delete('/api/v1/journeys/:journeyId/members/:userId', { preHandler: protectMutation }, async (request, reply) => {
    await platform.removeMember(request.auth.userId, request.params.journeyId, request.params.userId);
    return reply.code(204).send();
  });

  app.post('/api/v1/journeys/:journeyId/expenses', { preHandler: protectMutation }, async (request, reply) => reply.code(201).send({ data: { expense: await platform.createExpense(request.auth.userId, request.params.journeyId, request.body || {}) } }));
  app.patch('/api/v1/journeys/:journeyId/expenses/:expenseId', { preHandler: protectMutation }, async (request) => ({ data: { expense: await platform.mutateExpense(request.auth.userId, request.params.journeyId, request.params.expenseId, request.body || {}) } }));
  app.delete('/api/v1/journeys/:journeyId/expenses/:expenseId', { preHandler: protectMutation }, async (request, reply) => {
    await platform.mutateExpense(request.auth.userId, request.params.journeyId, request.params.expenseId, request.body || {}, { remove: true });
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
