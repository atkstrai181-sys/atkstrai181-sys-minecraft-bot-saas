import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UserRole } from '@prisma/client';

export function requireRole(app: FastifyInstance, roles: UserRole[]) {
  return async (request: FastifyRequest) => {
    const user = await app.prisma.user.findUnique({
      where: { id: request.userId },
      select: { role: true, status: true }
    });

    if (!user || !roles.includes(user.role) || user.status !== 'ACTIVE') {
      throw app.httpErrors.forbidden('Insufficient permissions');
    }
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}
