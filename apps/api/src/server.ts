import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import websocket from '@fastify/websocket';
import { PrismaClient, UserRole, UserStatus } from '@prisma/client';
import { z } from 'zod';
import { createGoogleAuthorization, consumeGoogleCallback, googleConfigured } from './google-oauth.js';
import { requireRole } from './rbac.js';

const prisma = new PrismaClient();
const app = Fastify({ logger: true });
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

app.decorate('prisma', prisma);

declare module 'fastify' {
  interface FastifyRequest { userId: string }
}

async function createSession(userId: string) {
  const id = randomBytes(32).toString('hex');
  await prisma.session.create({ data: { id, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
  return id;
}

async function requireSession(request: FastifyRequest) {
  const sessionId = request.cookies.session;
  if (!sessionId) throw app.httpErrors.unauthorized();

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: { select: { id: true, status: true } } }
  });

  if (!session || session.expiresAt <= new Date()) {
    if (session) await prisma.session.delete({ where: { id: session.id } });
    throw app.httpErrors.unauthorized();
  }

  if (session.user.status !== UserStatus.ACTIVE) {
    throw app.httpErrors.forbidden('Account is not active');
  }

  request.userId = session.user.id;
}

app.register(sensible);
app.register(cors, { origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true });
app.register(cookie, { secret: process.env.SESSION_SECRET ?? 'development-secret', hook: 'onRequest' });
app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
app.register(websocket);

app.get('/health/live', async () => ({ status: 'ok' }));
app.get('/health/ready', async () => { await prisma.$queryRaw`SELECT 1`; return { status: 'ready' }; });

app.get('/api/auth/google', async (_request, reply) => {
  if (!googleConfigured()) throw app.httpErrors.serviceUnavailable('Google OAuth is not configured');
  const { url } = await createGoogleAuthorization(prisma);
  return reply.redirect(url);
});

app.get('/api/auth/google/callback', async (request, reply) => {
  const query = z.object({
    code: z.string().min(1),
    state: z.string().min(1),
    error: z.string().optional()
  }).parse(request.query);

  if (query.error) {
    throw app.httpErrors.unauthorized('Google authorization denied');
  }

  if (request.cookies.oauth_state !== query.state) {
    throw app.httpErrors.unauthorized('OAuth state mismatch');
  }

  const user = await consumeGoogleCallback(prisma, query.code, query.state);
  const sessionId = await createSession(user.id);
  reply.clearCookie('oauth_state', { path: '/api/auth/google' });
  reply.setCookie('session', sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000
  });

  const frontendOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
  return reply.redirect(frontendOrigin);
});

app.post('/api/auth/logout', { preHandler: requireSession }, async (request, reply) => {
  const sessionId = request.cookies.session;
  if (sessionId) await prisma.session.deleteMany({ where: { id: sessionId } });
  reply.clearCookie('session', { path: '/' });
  return { ok: true };
});

app.get('/api/me', { preHandler: requireSession }, async (request) => prisma.user.findUnique({
  where: { id: request.userId },
  select: { id: true, email: true, name: true, role: true, status: true, license: true }
}));

app.get('/api/admin/check', {
  preHandler: [requireSession, requireRole(app, [UserRole.ADMIN, UserRole.SUPER_ADMIN])]
}, async (request) => ({ ok: true, userId: request.userId }));

app.get('/api/admin/users', {
  preHandler: [requireSession, requireRole(app, [UserRole.ADMIN, UserRole.SUPER_ADMIN])]
}, async () => prisma.user.findMany({
  select: {
    id: true,
    email: true,
    name: true,
    role: true,
    status: true,
    createdAt: true,
    license: { select: { status: true, maxBots: true, proxySlots: true, expiresAt: true } }
  },
  orderBy: { createdAt: 'desc' },
  take: 100
}));

app.get('/api/events', { websocket: true }, (socket, request) => {
  const sessionId = request.cookies.session;
  if (!sessionId) return socket.close(1008, 'Unauthorized');

  void prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: { select: { status: true } } }
  }).then((session) => {
    if (!session || session.expiresAt <= new Date() || session.user.status !== UserStatus.ACTIVE) {
      socket.close(1008, 'Unauthorized');
      return;
    }
    socket.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  });
});

async function cleanupExpiredOAuthStates() {
  await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

const stateCleanup = setInterval(() => cleanupExpiredOAuthStates().catch(error => app.log.error(error)), 60_000);

async function shutdown() {
  clearInterval(stateCleanup);
  await app.close();
  await prisma.$disconnect();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
