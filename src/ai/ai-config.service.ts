import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { MockScenario } from './ai-result.schema';
import { MOCK_SCENARIOS } from './ai-result.schema';

@Injectable()
export class AiConfigService {
  get apiKey() {
    return process.env.OPENAI_API_KEY?.trim() || null;
  }

  get model() {
    return process.env.OPENAI_MODEL?.trim() || null;
  }

  get timeoutMs() {
    return this.positiveInteger('OPENAI_TIMEOUT_MS', 25_000);
  }

  get maxRetries() {
    return this.nonNegativeInteger('OPENAI_MAX_RETRIES', 1);
  }

  get maxOutputTokens() {
    return this.positiveInteger('OPENAI_MAX_OUTPUT_TOKENS', 600);
  }

  get reasoningEffort() {
    const value = process.env.OPENAI_REASONING_EFFORT?.trim() || 'minimal';
    if (!['none', 'minimal', 'low', 'medium', 'high'].includes(value)) {
      throw new Error('OPENAI_REASONING_EFFORT has an invalid value');
    }
    return value as 'none' | 'minimal' | 'low' | 'medium' | 'high';
  }

  get mockMode() {
    return process.env.OPENAI_MOCK_MODE?.toLowerCase() === 'true';
  }

  get inputPricePerMillion() {
    return this.optionalPrice('OPENAI_INPUT_PRICE_PER_1M');
  }

  get outputPricePerMillion() {
    return this.optionalPrice('OPENAI_OUTPUT_PRICE_PER_1M');
  }

  get providerModel() {
    if (this.mockMode) return 'mock-model';
    if (!this.apiKey || !this.model) {
      throw new ServiceUnavailableException('OpenAI API не настроен');
    }
    return this.model;
  }

  get configured() {
    return this.mockMode || Boolean(this.apiKey && this.model);
  }

  parseDebugScenario(value?: string): MockScenario {
    if (!value) return 'CONTINUE';
    if (process.env.NODE_ENV === 'production') {
      throw new BadRequestException('Debug-сценарий недоступен в production');
    }
    if (!MOCK_SCENARIOS.includes(value as MockScenario)) {
      throw new BadRequestException('Неизвестный debug-сценарий');
    }
    return value as MockScenario;
  }

  private positiveInteger(name: string, fallback: number) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private nonNegativeInteger(name: string, fallback: number) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private optionalPrice(name: string) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 && process.env[name] !== ''
      ? value
      : null;
  }
}
