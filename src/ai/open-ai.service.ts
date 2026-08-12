import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { ZodError } from 'zod';
import { AiConfigService } from './ai-config.service';
import {
  AiResultSchema,
  type AiResult,
  type MockScenario,
} from './ai-result.schema';

export type ProviderUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type ProviderResult =
  | {
      kind: 'completed';
      result: AiResult;
      responseId: string | null;
      usage: ProviderUsage;
      latencyMs: number;
    }
  | {
      kind: 'refused';
      responseId: string | null;
      latencyMs: number;
    };

export class AiProviderError extends Error {
  constructor(
    readonly code:
      'INVALID_OUTPUT' | 'TIMEOUT' | 'UNAVAILABLE' | 'REQUEST_ERROR',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

@Injectable()
export class OpenAiService {
  constructor(private readonly config: AiConfigService) {}

  async generate(
    systemPrompt: string,
    input: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    scenario: MockScenario,
  ): Promise<ProviderResult> {
    const attempts = this.config.maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return this.config.mockMode
          ? this.mock(scenario, systemPrompt)
          : await this.real(systemPrompt, input);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof ZodError ||
          (error instanceof AiProviderError && error.retryable);
        if (!retryable || attempt === attempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }

    if (lastError instanceof ZodError) {
      throw new AiProviderError(
        'INVALID_OUTPUT',
        'OpenAI не вернул корректный результат',
        false,
      );
    }
    throw lastError;
  }

  private async real(
    systemPrompt: string,
    input: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ): Promise<ProviderResult> {
    const startedAt = Date.now();
    const client = new OpenAI({
      apiKey: this.config.apiKey!,
      timeout: this.config.timeoutMs,
      maxRetries: 0,
    });

    try {
      const response = await client.responses.parse({
        model: this.config.providerModel,
        instructions: systemPrompt,
        input,
        text: { format: zodTextFormat(AiResultSchema, 'ai_sales_result') },
      });
      const refusal = response.output.some(
        (item) =>
          item.type === 'message' &&
          item.content.some((content) => content.type === 'refusal'),
      );
      if (refusal) {
        return {
          kind: 'refused',
          responseId: response.id,
          latencyMs: Date.now() - startedAt,
        };
      }
      if (!response.output_parsed) {
        throw new ZodError([]);
      }
      const result = AiResultSchema.parse(response.output_parsed);
      return {
        kind: 'completed',
        result,
        responseId: response.id,
        latencyMs: Date.now() - startedAt,
        usage: {
          inputTokens: response.usage?.input_tokens ?? null,
          outputTokens: response.usage?.output_tokens ?? null,
          totalTokens: response.usage?.total_tokens ?? null,
        },
      };
    } catch (error) {
      if (error instanceof ZodError) throw error;
      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new AiProviderError('TIMEOUT', 'OpenAI timeout', true);
      }
      if (error instanceof OpenAI.APIConnectionError) {
        throw new AiProviderError(
          'UNAVAILABLE',
          'OpenAI connection error',
          true,
        );
      }
      if (error instanceof OpenAI.APIError) {
        const retryable = error.status === 429 || (error.status ?? 0) >= 500;
        throw new AiProviderError(
          retryable ? 'UNAVAILABLE' : 'REQUEST_ERROR',
          'OpenAI API error',
          retryable,
        );
      }
      throw error;
    }
  }

  private mock(scenario: MockScenario, systemPrompt: string): ProviderResult {
    const startedAt = Date.now();
    if (scenario === 'TIMEOUT') {
      throw new AiProviderError('TIMEOUT', 'Mock timeout', true);
    }
    if (scenario === 'INVALID_OUTPUT') {
      AiResultSchema.parse({ reply: '' });
    }
    if (scenario === 'REFUSED') {
      return { kind: 'refused', responseId: 'mock-refusal', latencyMs: 1 };
    }

    const language = systemPrompt.includes('Current language hint: kk')
      ? 'kk'
      : systemPrompt.includes('Current language hint: en')
        ? 'en'
        : 'ru';
    const replies = {
      ru: 'Детерминированный тестовый ответ.',
      kk: 'Детерминирленген сынақ жауабы.',
      en: 'Deterministic test response.',
    };
    const base: AiResult = {
      reply: replies[language],
      action: 'CONTINUE',
      leadDecision: 'NOT_READY',
      summary: null,
      qualificationReason: null,
      extractedData: {
        decisionMaker: null,
        mastersCount: null,
        doctorsCount: null,
        currentCrm: null,
        currentProcess: null,
        interestedInDemo: null,
        preferredContactTime: null,
        objections: [],
        needs: [],
      },
      shouldCreateLead: false,
      shouldCloseConversation: false,
    };
    const variants: Partial<Record<MockScenario, Partial<AiResult>>> = {
      QUALIFIED: {
        action: 'QUALIFY',
        leadDecision: 'QUALIFIED',
        summary: 'Клиент квалифицирован в mock-режиме.',
        qualificationReason: 'Подтвержден тестовый интерес.',
        shouldCreateLead: true,
      },
      REJECTED: {
        action: 'STOP',
        leadDecision: 'REJECTED',
        summary: 'Клиент отказался в mock-режиме.',
        qualificationReason: 'Получен тестовый отказ.',
        shouldCloseConversation: true,
      },
      HANDOFF: {
        action: 'HANDOFF',
        leadDecision: 'QUALIFIED',
        summary: 'Требуется менеджер.',
        qualificationReason: 'Запрошена ручная консультация.',
        shouldCreateLead: true,
      },
    };
    const result = AiResultSchema.parse({
      ...base,
      ...(variants[scenario] ?? {}),
    });
    return {
      kind: 'completed',
      result,
      responseId: `mock-${scenario.toLowerCase()}`,
      latencyMs: Math.max(1, Date.now() - startedAt),
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    };
  }
}
