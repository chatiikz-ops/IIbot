import { Injectable } from '@nestjs/common';
import { resolve } from 'node:path';

@Injectable()
export class WhatsAppConfigService {
  constructor() {
    if (!process.env.WHATSAPP_ENABLED) {
      try {
        process.loadEnvFile();
      } catch {
        // Environment variables may be supplied by the runtime instead of a file.
      }
    }
  }

  get enabled() {
    return process.env.WHATSAPP_ENABLED?.trim().toLowerCase() === 'true';
  }

  get clientId() {
    const value = process.env.WHATSAPP_CLIENT_ID?.trim() || 'zapis-ai-main';
    if (!/^[-_A-Za-z0-9]+$/.test(value)) {
      throw new Error('WHATSAPP_CLIENT_ID has an invalid format');
    }
    return value;
  }

  get sessionPath() {
    return resolve(
      process.env.WHATSAPP_SESSION_PATH?.trim() || './storage/whatsapp',
    );
  }

  get headless() {
    return process.env.WHATSAPP_HEADLESS?.trim().toLowerCase() !== 'false';
  }

  get qrTtlSeconds() {
    return this.positiveInteger('WHATSAPP_QR_TTL_SECONDS', 120);
  }

  get initTimeoutMs() {
    return this.positiveInteger('WHATSAPP_INIT_TIMEOUT_MS', 60_000);
  }

  private positiveInteger(name: string, fallback: number) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
