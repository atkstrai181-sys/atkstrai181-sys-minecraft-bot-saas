import { z } from 'zod';

export const runtimeConfigSchema = z.object({
  botId: z.string().min(1),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(64),
  version: z.string().trim().min(1).max(32).nullable().optional(),
  authType: z.enum(['OFFLINE', 'MICROSOFT']),
  password: z.string().max(512).nullable().optional(),
  reconnect: z.object({
    enabled: z.boolean(),
    initialDelay: z.number().int().min(0).max(300_000),
    retryInterval: z.number().int().min(1_000).max(900_000),
    maxAttempts: z.number().int().min(0).max(100),
    backoff: z.number().min(1).max(10),
    maxBackoff: z.number().int().min(1_000).max(3_600_000)
  })
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type RuntimeStatus = 'STOPPED' | 'CONNECTING' | 'ONLINE' | 'RECONNECTING' | 'CRASHED';
export type RuntimeEvent =
  | { type: 'status'; botId: string; status: RuntimeStatus; timestamp: string }
  | { type: 'chat'; botId: string; username?: string; message: string; timestamp: string }
  | { type: 'error'; botId: string; message: string; timestamp: string };

export function redact(value: string): string {
  return value.replace(/(password|token|secret)(\s*[:=]\s*)[^\s,]+/gi, '$1$2********');
}

export function safeCommand(command: string): string {
  const value = command.trim();
  if (!/^\/[a-zA-Z0-9_:-]+(?:\s+[^\n]{0,240})?$/.test(value)) {
    throw new Error('Invalid Minecraft command');
  }
  return value;
}
