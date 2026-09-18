import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import websocket from '@fastify/websocket';
import { PrismaClient, UserRole, UserStatus, LicenseStatus, BotStatus, DesiredState } from '@prisma/client';
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

const createLicenseInput = z.object({
  userId: z.string().cuid(),
  maxBots: z.number().int().min(0).max(1000),
  proxySlots: z.number().int().min(0).max(1000),
  days: z.number().int().min(1).max(3650),
  note: z.string().max(500).optional()
});

const licenseStatusMap = {
  ACTIVE: LicenseStatus.ACTIVE,
  EXPIRED: LicenseStatus.EXPIRED,
  SUSPENDED: LicenseStatus.SUSPENDED,
  CANCELLED: LicenseStatus.CANCELLED
} as const;

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

async function requireEntitlement(userId: string) {
  const license = await prisma.license.findUnique({ where: { userId } });
  if (!license || license.status !== LicenseStatus.ACTIVE || license.expiresAt <= new Date()) {
    throw app.httpErrors.forbidden('Active license required');
  }
  return license;
}

async function audit(actorId: string | null, action: string, targetType: string, targetId: string, oldValue?: unknown, newValue?: unknown) {
  await prisma.auditLog.create({
    data: {
      actorId,
      action,
      targetType,
      targetId,
      oldValue: oldValue ? JSON.stringify(oldValue) as any : undefined,
      newValue: newValue ? JSON.stringify(newValue) as any : undefined
    }
  });
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
  const query = z.object({ code: z.string().min(1), state: z.string().min(1), error: z.string().optional() }).parse(request.query);
  if (query.error) throw app.httpErrors.unauthorized('Google authorization denied');
  if (request.cookies.oauth_state !== query.state) throw app.httpErrors.unauthorized('OAuth state mismatch');

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

  return reply.redirect(process.env.WEB_ORIGIN ?? 'http://localhost:5173');
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

app.get('/api/me/license', { preHandler: requireSession }, async (request) => {
  const license = await prisma.license.findUnique({ where: { userId: request.userId } });
  if (!license) return { active: false, message: 'Henüz aktif bir paketiniz yok. Paket almak için lütfen yönetici ile görüşün.' };
  return { active: license.status === LicenseStatus.ACTIVE && license.expiresAt > new Date(), license };
});

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

app.post('/api/admin/licenses', {
  preHandler: [requireSession, requireRole(app, [UserRole.ADMIN, UserRole.SUPER_ADMIN])]
}, async (request, reply) => {
  const input = createLicenseInput.parse(request.body);
  const actorId = request.userId;
  const targetUser = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, email: true, status: true } });
  if (!targetUser) throw app.httpErrors.notFound();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.days * 24 * 60 * 60 * 1000);
  const existing = await prisma.license.findUnique({ where: { userId: input.userId } });
  const oldValue = existing ? { ...existing } : null;

  const created = await prisma.$transaction(async (tx) => {
    const license = existing ? await tx.license.update({
      where: { userId: input.userId },
      data: {
        maxBots: input.maxBots,
        proxySlots: input.proxySlots,
        startsAt: now,
        expiresAt,
        totalDays: input.days,
        status: LicenseStatus.ACTIVE
      }
    }) : await tx.license.create({
      data: {
        userId: input.userId,
        maxBots: input.maxBots,
        proxySlots: input.proxySlots,
        startsAt: now,
        expiresAt,
        totalDays: input.days,
        status: LicenseStatus.ACTIVE
      }
    });

    await tx.licenseHistory.create({
      data: {
        licenseId: license.id,
        actorId,
        oldValue: oldValue ? JSON.parse(JSON.stringify(oldValue)) : undefined,
        newValue: { ...license, userId: input.userId },
        note: input.note ?? 'License assigned by admin'
      }
    });

    await tx.auditLog.create({
      data: {
        actorId,
        action: existing ? 'LICENSE_UPDATED' : 'LICENSE_CREATED',
        targetType: 'License',
        targetId: license.id,
        oldValue: oldValue ? JSON.parse(JSON.stringify(oldValue)) : undefined,
        newValue: { ...license, userId: input.userId }
      }
    });

    await tx.bot.updateMany({
      where: { userId: input.userId, desiredState: DesiredState.RUNNING },
      data: { desiredState: DesiredState.STOPPED, status: BotStatus.EXPIRED }
    });

    return license;
  });

  return reply.code(201).send(created);
});

app.get('/api/admin/licenses/:userId', {
  preHandler: [requireSession, requireRole(app, [UserRole.ADMIN, UserRole.SUPER_ADMIN])]
}, async (request) => {
  const { userId } = z.object({ userId: z.string().cuid() }).parse(request.params);
  const license = await prisma.license.findUnique({ where: { userId } });
  if (!license) throw app.httpErrors.notFound();
  return license;
});

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

async function expireLicenses() {
  const now = new Date();
  const expired = await prisma.license.findMany({
    where: { status: LicenseStatus.ACTIVE, expiresAt: { lte: now } },
    select: { userId: true, id: true, expiresAt: true }
  });

  for (const license of expired) {
    await prisma.$transaction(async (tx) => {
      await tx.license.update({
        where: { id: license.id },
        data: { status: LicenseStatus.EXPIRED }
      });

      await tx.bot.updateMany({
        where: { userId: license.userId, desiredState: DesiredState.RUNNING },
        data: { desiredState: DesiredState.STOPPED, status: BotStatus.EXPIRED }
      });

      await tx.auditLog.create({
        data: {
          action: 'LICENSE_EXPIRED',
          targetType: 'License',
          targetId: license.id,
          newValue: { expiredAt: license.expiresAt }
        }
      });

      await tx.notification.create({
        data: {
          userId: license.userId,
          type: 'LICENSE_EXPIRED',
          message: 'Lisansınızın süresi doldu. Botlarınız durduruldu.'
        }
      });
    });
  }
}

const licenseWorker = setInterval(() => expireLicenses().catch((error) => app.log.error(error)), 60_000);

async function shutdown() {
  clearInterval(licenseWorker);
  await app.close();
  await prisma.$disconnect();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
