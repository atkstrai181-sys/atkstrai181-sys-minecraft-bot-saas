import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { PrismaClient, BotStatus, DesiredState, LicenseStatus, UserStatus } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();
const app = Fastify({ logger: true });

declare module 'fastify' { interface FastifyRequest { userId: string } }

const idParam = z.object({ id: z.string().cuid() });
const createBot = z.object({ name: z.string().trim().min(1).max(64), host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535).default(25565), username: z.string().min(1).max(64), authType: z.enum(['OFFLINE', 'MICROSOFT']).default('OFFLINE') });

// OAuth callback will replace this development identity. Production must set userId from a verified session only.
async function requireSession(request: FastifyRequest) {
  const userId = request.cookies.session;
  if (!userId) throw app.httpErrors.unauthorized();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
  if (!user || user.status !== UserStatus.ACTIVE) throw app.httpErrors.forbidden('Account is not active');
  request.userId = user.id;
}

async function requireEntitlement(userId: string) {
  const license = await prisma.license.findUnique({ where: { userId } });
  if (!license || license.status !== LicenseStatus.ACTIVE || license.expiresAt <= new Date()) throw app.httpErrors.forbidden('Active license required');
  return license;
}

app.register(cors, { origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true });
app.register(cookie, { secret: process.env.SESSION_SECRET });
app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
app.register(websocket);

app.get('/health/live', async () => ({ status: 'ok' }));
app.get('/health/ready', async () => { await prisma.$queryRaw`SELECT 1`; return { status: 'ready' }; });

app.get('/api/me', { preHandler: requireSession }, async (request) => prisma.user.findUnique({ where: { id: request.userId }, select: { id: true, email: true, name: true, role: true, status: true, license: true } }));
app.get('/api/bots', { preHandler: requireSession }, async (request) => prisma.bot.findMany({ where: { userId: request.userId }, include: { connection: true, auth: { select: { username: true, authType: true } } }, orderBy: { createdAt: 'desc' } }));

app.post('/api/bots', { preHandler: requireSession }, async (request, reply) => {
  const license = await requireEntitlement(request.userId);
  const input = createBot.parse(request.body);
  const count = await prisma.bot.count({ where: { userId: request.userId, status: { not: BotStatus.DISABLED } } });
  if (count >= license.maxBots) throw app.httpErrors.forbidden('Bot limit reached');
  const bot = await prisma.bot.create({ data: { userId: request.userId, name: input.name, connection: { create: { host: input.host, port: input.port } }, auth: { create: { username: input.username, authType: input.authType } } }, include: { connection: true, auth: { select: { username: true, authType: true } } } });
  return reply.code(201).send(bot);
});

app.post('/api/bots/:id/start', { preHandler: requireSession }, async (request) => {
  const { id } = idParam.parse(request.params);
  const license = await requireEntitlement(request.userId);
  const bot = await prisma.bot.findFirst({ where: { id, userId: request.userId } });
  if (!bot) throw app.httpErrors.notFound();
  // The entitlement is checked immediately before changing desired state; the worker/runtime checks again.
  if (license.expiresAt <= new Date()) throw app.httpErrors.forbidden('License expired');
  return prisma.bot.update({ where: { id }, data: { desiredState: DesiredState.RUNNING, status: BotStatus.STARTING } });
});
app.post('/api/bots/:id/stop', { preHandler: requireSession }, async (request) => {
  const { id } = idParam.parse(request.params);
  const bot = await prisma.bot.findFirst({ where: { id, userId: request.userId } });
  if (!bot) throw app.httpErrors.notFound();
  return prisma.bot.update({ where: { id }, data: { desiredState: DesiredState.STOPPED, status: BotStatus.STOPPING } });
});

app.get('/api/bots/:id/logs', { preHandler: requireSession }, async (request) => { const { id } = idParam.parse(request.params); const bot = await prisma.bot.findFirst({ where: { id, userId: request.userId }, select: { id: true } }); if (!bot) throw app.httpErrors.notFound(); return prisma.botLog.findMany({ where: { botId: id }, orderBy: { createdAt: 'desc' }, take: 200 }); });

app.get('/api/events', { websocket: true }, (socket, request) => {
  const userId = request.cookies.session;
  if (!userId) return socket.close(1008, 'Unauthorized');
  socket.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  socket.on('message', async (raw) => { try { const message = z.object({ type: z.literal('subscribe'), botId: z.string().cuid() }).parse(JSON.parse(raw.toString())); const bot = await prisma.bot.findFirst({ where: { id: message.botId, userId }, select: { id: true } }); if (bot) socket.send(JSON.stringify({ type: 'subscribed', botId: bot.id })); } catch { socket.send(JSON.stringify({ type: 'error', message: 'Invalid subscription' })); } });
});

async function expireLicenses() { const expired = await prisma.license.findMany({ where: { status: LicenseStatus.ACTIVE, expiresAt: { lte: new Date() } }, select: { userId: true } }); for (const item of expired) { await prisma.$transaction([prisma.license.updateMany({ where: { userId: item.userId, status: LicenseStatus.ACTIVE, expiresAt: { lte: new Date() } }, data: { status: LicenseStatus.EXPIRED } }), prisma.bot.updateMany({ where: { userId: item.userId, status: { not: BotStatus.STOPPED } }, data: { desiredState: DesiredState.STOPPED, status: BotStatus.EXPIRED } })]); } }

const interval = setInterval(() => expireLicenses().catch((error) => app.log.error(error)), 60_000);
async function shutdown() { clearInterval(interval); await app.close(); await prisma.$disconnect(); }
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }).catch((error) => { app.log.error(error); process.exit(1); });
