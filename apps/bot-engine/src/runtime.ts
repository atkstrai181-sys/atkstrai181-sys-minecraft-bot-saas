import mineflayer, { type Bot } from 'mineflayer';
import { runtimeConfigSchema, safeCommand, type RuntimeConfig, type RuntimeEvent, type RuntimeStatus } from './types.js';

type Listener = (event: RuntimeEvent) => void;

/**
 * Owns exactly one Mineflayer instance. It never evaluates user supplied code.
 * The API process can host one manager per worker process, while a supervisor
 * can restart this process without taking down unrelated API requests.
 */
export class BotRuntime {
  private bot: Bot | undefined;
  private status: RuntimeStatus = 'STOPPED';
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private shuttingDown = false;

  constructor(private readonly config: RuntimeConfig, private readonly listener: Listener) {
    runtimeConfigSchema.parse(config);
  }

  getStatus(): RuntimeStatus { return this.status; }

  start(): void {
    this.shuttingDown = false;
    this.attempts = 0;
    this.connect();
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const bot = this.bot;
    this.bot = undefined;
    if (bot) bot.quit('Runtime stopped');
    this.setStatus('STOPPED');
  }

  sendCommand(command: string): void {
    if (!this.bot || this.status !== 'ONLINE') throw new Error('Bot is not online');
    this.bot.chat(safeCommand(command));
  }

  private connect(): void {
    if (this.shuttingDown) return;
    this.setStatus(this.attempts ? 'RECONNECTING' : 'CONNECTING');
    const options: Parameters<typeof mineflayer.createBot>[0] = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      version: this.config.version ?? undefined,
      auth: this.config.authType === 'MICROSOFT' ? 'microsoft' : 'offline',
      ...(this.config.password ? { password: this.config.password } : {})
    };
    const bot = mineflayer.createBot(options);
    this.bot = bot;
    bot.once('spawn', () => { this.attempts = 0; this.setStatus('ONLINE'); });
    bot.on('chat', (username, message) => this.emit({ type: 'chat', botId: this.config.botId, username, message, timestamp: new Date().toISOString() }));
    bot.on('error', error => this.emitError(error));
    bot.on('kicked', reason => this.emitError(new Error(`Kicked: ${String(reason).slice(0, 500)}`)));
    bot.once('end', () => {
      if (this.bot !== bot) return;
      this.bot = undefined;
      if (!this.shuttingDown && this.config.reconnect.enabled) this.scheduleReconnect();
      else this.setStatus('STOPPED');
    });
  }

  private scheduleReconnect(): void {
    if (this.attempts >= this.config.reconnect.maxAttempts) { this.setStatus('CRASHED'); return; }
    const delay = Math.min(this.config.reconnect.initialDelay * Math.pow(this.config.reconnect.backoff, this.attempts), this.config.reconnect.maxBackoff);
    this.attempts += 1;
    this.setStatus('RECONNECTING');
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, delay);
  }

  private emitError(error: unknown): void {
    this.emit({ type: 'error', botId: this.config.botId, message: error instanceof Error ? error.message : 'Unknown bot error', timestamp: new Date().toISOString() });
  }

  private setStatus(status: RuntimeStatus): void {
    this.status = status;
    this.emit({ type: 'status', botId: this.config.botId, status, timestamp: new Date().toISOString() });
  }

  private emit(event: RuntimeEvent): void { this.listener(event); }
}
