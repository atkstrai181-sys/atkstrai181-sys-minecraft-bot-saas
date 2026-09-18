import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runtimeConfigSchema, type RuntimeConfig, type RuntimeEvent } from '../../bot-engine/src/types.js';

type EventHandler = (event: RuntimeEvent) => void;

/** Fixed-command child-process boundary. No user-controlled executable or shell is accepted. */
export class BotSupervisor {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private readonly handlers = new Set<EventHandler>();
  private readonly started = new Set<string>();

  constructor(private readonly onEvent?: EventHandler) {
    if (onEvent) this.handlers.add(onEvent);
  }

  addHandler(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.child) return;
    const apiDir = dirname(fileURLToPath(import.meta.url));
    const defaultEntry = resolve(apiDir, '../../../bot-engine/dist/index.js');
    const entry = process.env.BOT_ENGINE_ENTRY ?? defaultEntry;
    this.child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { ...process.env } });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.consume(String(chunk)));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => console.error(`[bot-engine] ${String(chunk).trim()}`));
    this.child.on('exit', () => { this.child = undefined; this.started.clear(); });
    this.child.on('error', error => console.error('[bot-engine] process error', error));
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    await Promise.race([new Promise<void>(resolveExit => this.child?.once('exit', () => resolveExit())), new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 5000))]);
    this.child?.kill('SIGTERM');
    this.child = undefined;
    this.started.clear();
  }

  async startBot(config: RuntimeConfig): Promise<void> {
    runtimeConfigSchema.parse(config);
    await this.start();
    this.send({ action: 'start', config });
    this.started.add(config.botId);
  }

  stopBot(botId: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(botId)) throw new Error('Invalid bot id');
    if (!this.child) return;
    this.send({ action: 'stop', botId });
    this.started.delete(botId);
  }

  sendCommand(botId: string, command: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(botId)) throw new Error('Invalid bot id');
    if (!this.child || !this.started.has(botId)) throw new Error('Bot runtime is not active');
    this.send({ action: 'command', botId, command });
  }

  private send(message: object): void {
    if (!this.child?.stdin.writable) throw new Error('Bot engine is unavailable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        try {
          const event = JSON.parse(line) as RuntimeEvent;
          for (const handler of this.handlers) handler(event);
        } catch { /* Ignore non-protocol output. */ }
      }
      index = this.buffer.indexOf('\n');
    }
  }
}
