import { resolve } from 'node:path';
import { config } from 'dotenv';

config({ path: resolve(__dirname, '..', '.env'), override: true, quiet: true });
process.env.WHATSAPP_ENABLED = 'false';
process.env.TELEGRAM_ENABLED = 'false';
process.env.NODE_ENV = 'test';
process.env.AUTOMATION_WORKER_ENABLED = 'false';
