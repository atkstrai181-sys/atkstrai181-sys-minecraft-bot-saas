# Minecraft Bot SaaS

Multi-tenant Minecraft Mineflayer bot platform foundation. The first slice includes a type-safe API, PostgreSQL/Prisma data model, license enforcement, tenant-scoped bot lifecycle endpoints, and a React dashboard shell.

## Stack

- Node.js 22 + TypeScript + Fastify
- Prisma + PostgreSQL
- React + Vite
- Zod validation
- `@fastify/cookie` session boundary (OAuth provider integration is intentionally configured through environment variables)

## Development

```bash
cp .env.example .env
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

The API listens on `http://localhost:3000`, and the web app on `http://localhost:5173`.

This repository deliberately does not accept or execute user JavaScript. Bot behavior is represented by validated database configurations and will be executed by the isolated bot-engine worker in the next implementation slice.
