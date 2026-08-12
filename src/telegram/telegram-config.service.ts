import { Injectable } from '@nestjs/common';

@Injectable()
export class TelegramConfigService {
  get enabled() {
    return process.env.TELEGRAM_ENABLED?.toLowerCase() === 'true';
  }
  get token() {
    return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
  }
  get username() {
    return process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '') || null;
  }
  get configured() {
    return Boolean(this.token && this.username);
  }
  get mockMode() {
    return process.env.TELEGRAM_MOCK_MODE?.toLowerCase() === 'true';
  }
  get timeoutMs() {
    const value = Number(process.env.TELEGRAM_REQUEST_TIMEOUT_MS);
    return Number.isInteger(value) && value > 0 ? value : 10_000;
  }
  get adminPublicUrl() {
    const value = process.env.ADMIN_PUBLIC_URL?.trim();
    if (!value || /localhost|127\.0\.0\.1/i.test(value)) return null;
    return value.replace(/\/$/, '');
  }
}
