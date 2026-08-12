import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { TelegramConfigService } from './telegram-config.service';

export type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number };
    from?: {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
  };
};

export type TelegramBotIdentity = {
  id: number;
  username?: string;
  first_name?: string;
};

export class TelegramApiError extends Error {
  constructor(
    readonly httpStatus: number | null,
    readonly telegramOk: boolean,
    readonly errorCode: number | null,
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class TelegramBotService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TelegramBotService.name);
  private running = false;
  private offset = 0;
  private handlers: Array<(update: TelegramUpdate) => Promise<void>> = [];
  private mockCounter = 0;

  constructor(private readonly config: TelegramConfigService) {}

  onUpdate(handler: (update: TelegramUpdate) => Promise<void>) {
    this.handlers.push(handler);
  }

  async onModuleInit() {
    this.logger.log(
      this.config.enabled ? 'Telegram enabled' : 'Telegram disabled',
    );
    if (!this.config.enabled) return;
    if (!this.config.configured) {
      this.logger.error('Telegram connection error: bot is not configured');
      return;
    }
    if (this.config.mockMode) {
      this.logger.log('Telegram mock mode enabled; polling disabled');
      return;
    }
    this.logger.log('Starting Telegram polling');
    try {
      const bot = await this.getMe();
      this.logger.log('Telegram getMe successful');
      this.logger.log(`Bot username: ${bot.username ?? 'not-set'}`);
      this.logger.log(`Bot id: ${bot.id}`);
      this.running = true;
      void this.poll();
      this.logger.log('Telegram polling started');
    } catch (error) {
      this.logger.error(`Telegram connection error: ${this.safeError(error)}`);
    }
  }

  onApplicationShutdown() {
    this.running = false;
    this.logger.log('Polling stopped');
  }

  async getMe(): Promise<TelegramBotIdentity> {
    if (this.config.mockMode)
      return { id: 0, username: 'mock_bot', first_name: 'Mock bot' };
    return (await this.request('getMe', {})) as TelegramBotIdentity;
  }

  async sendMessage(
    chatId: bigint,
    text: string,
    url?: { label: string; value: string },
  ) {
    if (this.config.mockMode) {
      this.mockCounter += 1;
      return { message_id: this.mockCounter };
    }
    const result = await this.request('sendMessage', {
      chat_id: chatId.toString(),
      text,
      ...(url
        ? {
            reply_markup: {
              inline_keyboard: [[{ text: url.label, url: url.value }]],
            },
          }
        : {}),
    });
    return result as { message_id: number };
  }

  private async poll() {
    while (this.running) {
      try {
        const updates = (await this.request('getUpdates', {
          offset: this.offset,
          timeout: 20,
          allowed_updates: ['message'],
        })) as TelegramUpdate[];
        for (const update of updates) {
          this.offset = update.update_id + 1;
          for (const handler of this.handlers) await handler(update);
        }
      } catch (error) {
        this.logger.error(`Telegram polling error: ${this.safeError(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async request(method: string, body: Record<string, unknown>) {
    if (!this.config.token) throw new Error('TELEGRAM_NOT_CONFIGURED');
    let lastError: unknown;
    const requestTimeoutMs =
      method === 'getUpdates'
        ? Math.max(this.config.timeoutMs, 25_000)
        : this.config.timeoutMs;
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch(
          `https://api.telegram.org/bot${this.config.token}/${method}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );
        const payload = (await response.json()) as {
          ok: boolean;
          result?: unknown;
          error_code?: number;
          description?: string;
          parameters?: { retry_after?: number };
        };
        if (payload.ok) return payload.result;
        const retryable =
          payload.error_code === 429 || (payload.error_code ?? 0) >= 500;
        if (!retryable || attempt === 2)
          throw new TelegramApiError(
            response.status,
            payload.ok,
            payload.error_code ?? null,
            this.safeDescription(payload.description),
          );
        await new Promise((resolve) =>
          setTimeout(resolve, (payload.parameters?.retry_after ?? 1) * 1000),
        );
      } catch (error) {
        lastError = error;
        const retryable =
          !(error instanceof TelegramApiError) ||
          error.errorCode === 429 ||
          (error.httpStatus ?? 0) >= 500;
        if (!retryable || attempt === 2) throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  private safeError(error: unknown) {
    if (error instanceof TelegramApiError) {
      return `HTTP ${error.httpStatus ?? 'none'}, Telegram ${error.errorCode ?? 'error'}: ${error.message}`;
    }
    if (error instanceof Error) {
      if (error.name === 'AbortError') return 'timeout';
      const cause = error.cause as { code?: string } | undefined;
      return cause?.code ? `network ${cause.code}` : error.name;
    }
    return 'unknown error';
  }

  private safeDescription(value?: string) {
    return value?.slice(0, 300) || 'Telegram API error';
  }
}
