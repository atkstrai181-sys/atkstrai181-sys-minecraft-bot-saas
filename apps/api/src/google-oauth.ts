import { randomBytes, createHash } from 'node:crypto';
import type { PrismaClient, User } from '@prisma/client';

const provider = 'google';
const stateTtlMs = 10 * 60 * 1000;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALLBACK_URL);
}

export async function createGoogleAuthorization(prisma: PrismaClient): Promise<{ url: string; state: string }> {
  const state = randomBytes(32).toString('base64url');
  const stateId = createHash('sha256').update(state).digest('hex');
  await prisma.oAuthState.create({
    data: {
      id: stateId,
      provider,
      redirectUri: required('GOOGLE_CALLBACK_URL'),
      expiresAt: new Date(Date.now() + stateTtlMs)
    }
  });

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: required('GOOGLE_CLIENT_ID'),
    redirect_uri: required('GOOGLE_CALLBACK_URL'),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  }).toString();

  return { url: url.toString(), state };
}

export async function consumeGoogleCallback(prisma: PrismaClient, code: string, state: string): Promise<User> {
  const stateId = createHash('sha256').update(state).digest('hex');
  const stored = await prisma.oAuthState.findUnique({ where: { id: stateId } });
  if (!stored || stored.expiresAt <= new Date() || stored.provider !== provider) {
    throw new Error('Invalid or expired OAuth state');
  }
  await prisma.oAuthState.delete({ where: { id: stateId } });

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: required('GOOGLE_CLIENT_ID'),
      client_secret: required('GOOGLE_CLIENT_SECRET'),
      redirect_uri: stored.redirectUri,
      grant_type: 'authorization_code'
    })
  });

  if (!tokenResponse.ok) {
    throw new Error('Google token exchange failed');
  }

  const token = await tokenResponse.json() as { access_token?: string };
  if (!token.access_token) {
    throw new Error('Google did not return an access token');
  }

  const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${token.access_token}` }
  });

  if (!profileResponse.ok) {
    throw new Error('Google profile request failed');
  }

  const profile = await profileResponse.json() as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };

  if (!profile.sub || !profile.email || profile.email_verified !== true) {
    throw new Error('Google account email is not verified');
  }

  const email = profile.email.toLowerCase();
  const tempSuperAdminEmail = process.env.TEMP_SUPER_ADMIN_EMAIL?.toLowerCase();
  const registrationMode = process.env.REGISTRATION_MODE ?? 'open';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing && registrationMode === 'invite') {
    throw new Error('This email is not invited');
  }

  const user = existing ?? await prisma.user.create({
    data: {
      email,
      name: profile.name,
      avatarUrl: profile.picture
    }
  });

  const nextRole = tempSuperAdminEmail && email === tempSuperAdminEmail ? 'SUPER_ADMIN' : user.role;

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        name: profile.name ?? user.name,
        avatarUrl: profile.picture ?? user.avatarUrl,
        role: nextRole
      }
    }),
    prisma.oAuthAccount.upsert({
      where: {
        provider_providerAccountId: { provider, providerAccountId: profile.sub }
      },
      create: {
        userId: user.id,
        provider,
        providerAccountId: profile.sub
      },
      update: {
        userId: user.id
      }
    })
  ]);

  return { ...user, role: nextRole } as User;
}
