import { BotRuntime } from './runtime.js';
import { runtimeConfigSchema, type RuntimeEvent } from './types.js';

const active = new Map<string, BotRuntime>();

function write(event: RuntimeEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

// Supervisor protocol: newline-delimited JSON on stdin/stdout. Secrets never
// appear in status events. A real queue/IPC adapter can replace this boundary.
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line) as { action: string; config?: unknown; botId?: string; command?: string };
      if (message.action === 'start' && message.config) {
        const config = runtimeConfigSchema.parse(message.config);
        active.get(config.botId)?.stop().catch(write);
        const runtime = new BotRuntime(config, write);
        active.set(config.botId, runtime);
        runtime.start();
      } else if (message.action === 'stop' && message.botId) {
        active.get(message.botId)?.stop().catch(write);
        active.delete(message.botId);
      } else if (message.action === 'command' && message.botId && message.command) {
        active.get(message.botId)?.sendCommand(message.command);
      }
    } catch (error) {
      write({ type: 'error', botId: 'supervisor', message: error instanceof Error ? error.message : 'Invalid worker message', timestamp: new Date().toISOString() });
    }
  }
});

async function shutdown(): Promise<void> {
  await Promise.all([...active.values()].map(runtime => runtime.stop()));
  active.clear();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
