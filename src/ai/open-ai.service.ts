import { Injectable, Logger } from '@nestjs/common';
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
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

export type ProviderFailureMetadata = {
  responseId: string | null;
  status: string | null;
  incompleteReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  validationFailure?: 'EMPTY_OUTPUT' | 'INVALID_JSON' | 'SCHEMA_VALIDATION';
  schemaIssues?: Array<{ code: string; path: string; message: string }>;
  decisionSnapshot?: {
    action: unknown;
    leadDecision: unknown;
    shouldCreateLead: unknown;
    shouldCloseConversation: unknown;
  };
};

export type ProviderResult =
  | {
      kind: 'completed';
      result: AiResult;
      responseId: string | null;
      usage: ProviderUsage;
      latencyMs: number;
      attempts: number;
      providerStatus: string | null;
      incompleteReason: string | null;
    }
  | {
      kind: 'refused';
      responseId: string | null;
      latencyMs: number;
      attempts: number;
    };

export class AiProviderError extends Error {
  constructor(
    readonly code:
      'INVALID_OUTPUT' | 'TIMEOUT' | 'UNAVAILABLE' | 'REQUEST_ERROR',
    message: string,
    readonly retryable: boolean,
    public attempts = 1,
    readonly metadata?: ProviderFailureMetadata,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

@Injectable()
export class OpenAiService {
  private readonly logger = new Logger(OpenAiService.name);

  constructor(private readonly config: AiConfigService) {}

  async generate(
    systemPrompt: string,
    input: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    scenario: MockScenario,
  ): Promise<ProviderResult> {
    const attempts = this.config.maxRetries + 1;
    let lastError: unknown;
    let attemptCount = 0;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      attemptCount = attempt + 1;
      const attemptStartedAt = Date.now();
      try {
        const result = this.config.mockMode
          ? this.mock(scenario, systemPrompt)
          : await this.real(systemPrompt, input);
        this.logger.log({
          event: 'OPENAI_ATTEMPT_COMPLETED',
          attempt: attempt + 1,
          maxAttempts: attempts,
          durationMs: Date.now() - attemptStartedAt,
        });
        return { ...result, attempts: attempt + 1 };
      } catch (error) {
        lastError = error;
        const retryable = error instanceof AiProviderError && error.retryable;
        if (error instanceof AiProviderError) error.attempts = attempt + 1;
        this.logger.warn({
          event: 'OPENAI_ATTEMPT_FAILED',
          attempt: attempt + 1,
          maxAttempts: attempts,
          durationMs: Date.now() - attemptStartedAt,
          retryable,
          errorCode:
            error instanceof AiProviderError ? error.code : 'INVALID_OUTPUT',
        });
        if (!retryable || attempt === attempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }

    if (lastError instanceof ZodError) {
      const invalidOutput = new AiProviderError(
        'INVALID_OUTPUT',
        'OpenAI не вернул корректный результат',
        false,
      );
      invalidOutput.attempts = attemptCount;
      throw invalidOutput;
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
      const response = await client.responses.create({
        model: this.config.providerModel,
        instructions: systemPrompt,
        input,
        max_output_tokens: this.config.maxOutputTokens,
        reasoning: { effort: this.config.reasoningEffort },
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
          attempts: 1,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.output_text) as unknown;
      } catch {
        const metadata = {
          ...this.failureMetadata(response),
          validationFailure: response.output_text
            ? ('INVALID_JSON' as const)
            : ('EMPTY_OUTPUT' as const),
        };
        this.logger.warn({
          event: 'OPENAI_INVALID_OUTPUT_DIAGNOSTIC',
          ...metadata,
        });
        throw new AiProviderError(
          'INVALID_OUTPUT',
          'OpenAI did not return a parsed structured result',
          false,
          1,
          metadata,
        );
      }
      const validation = AiResultSchema.safeParse(parsed);
      if (!validation.success) {
        const metadata: ProviderFailureMetadata = {
          ...this.failureMetadata(response),
          validationFailure: 'SCHEMA_VALIDATION',
          schemaIssues: validation.error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path.join('.'),
            message: issue.message,
          })),
          decisionSnapshot: this.decisionSnapshot(parsed),
        };
        this.logger.warn({
          event: 'OPENAI_INVALID_OUTPUT_DIAGNOSTIC',
          ...metadata,
        });
        throw new AiProviderError(
          'INVALID_OUTPUT',
          'OpenAI structured result failed schema validation',
          false,
          1,
          metadata,
        );
      }
      const result = validation.data;
      return {
        kind: 'completed',
        result,
        responseId: response.id,
        latencyMs: Date.now() - startedAt,
        usage: {
          inputTokens: response.usage?.input_tokens ?? null,
          cachedInputTokens:
            response.usage?.input_tokens_details?.cached_tokens ?? null,
          outputTokens: response.usage?.output_tokens ?? null,
          reasoningTokens:
            response.usage?.output_tokens_details?.reasoning_tokens ?? null,
          totalTokens: response.usage?.total_tokens ?? null,
        },
        attempts: 1,
        providerStatus: response.status ?? null,
        incompleteReason: response.incomplete_details?.reason ?? null,
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

  private failureMetadata(response: {
    id?: string | null;
    status?: string | null;
    incomplete_details?: { reason?: string | null } | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      output_tokens_details?: { reasoning_tokens?: number };
    } | null;
  }): ProviderFailureMetadata {
    return {
      responseId: response.id ?? null,
      status: response.status ?? null,
      incompleteReason: response.incomplete_details?.reason ?? null,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      reasoningTokens:
        response.usage?.output_tokens_details?.reasoning_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
    };
  }

  private decisionSnapshot(value: unknown) {
    const object =
      value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};
    return {
      action: object.action ?? null,
      leadDecision: object.leadDecision ?? null,
      shouldCreateLead: object.shouldCreateLead ?? null,
      shouldCloseConversation: object.shouldCloseConversation ?? null,
    };
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
      return {
        kind: 'refused',
        responseId: 'mock-refusal',
        latencyMs: 1,
        attempts: 1,
      };
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
      usage: {
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 50,
        reasoningTokens: 0,
        totalTokens: 150,
      },
      attempts: 1,
      providerStatus: 'completed',
      incompleteReason: null,
    };
  }
}
