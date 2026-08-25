import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ConversationStatus, MessageRole } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { isTerminalConversationStatus } from '../conversations/conversation-status';
import { AiConfigService } from './ai-config.service';
import { AiDecisionService } from './ai-decision.service';
import { AiPromptBuilderService } from './ai-prompt-builder.service';
import { ConversationLanguageService } from './conversation-language.service';
import type { AiRunsQueryDto } from './dto/ai-runs-query.dto';
import {
  AiProviderError,
  OpenAiService,
  type ProviderResult,
} from './open-ai.service';

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AiConfigService,
    private readonly prompts: AiPromptBuilderService,
    private readonly openAi: OpenAiService,
    private readonly decisions: AiDecisionService,
    private readonly language: ConversationLanguageService,
  ) {}

  async generateFirstMessage(conversationId: string, scenarioValue?: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true, messages: { select: { id: true }, take: 1 } },
    });
    if (!conversation) throw new NotFoundException('Разговор не найден');
    if (conversation.contact.deletedAt) {
      throw new ForbiddenException('Контакт удалён');
    }
    if (!conversation.contact.outreachEligible) {
      throw new ForbiddenException(
        'Контакт исключён из автоматической обработки',
      );
    }
    if (conversation.strategyCode === 'SKIP_EXISTING_CLIENT') {
      throw new ForbiddenException(
        'Контакт исключён из автоматической обработки',
      );
    }
    if (conversation.messages.length > 0) {
      throw new ConflictException('Первое сообщение уже создано');
    }

    const scenario = this.config.parseDebugScenario(scenarioValue);
    const prompt = await this.prompts.build(conversationId, true);
    const run = await this.createRun(conversationId, null, prompt);
    try {
      const provider = await this.generateWithMetrics(
        run.id,
        prompt.systemPrompt,
        prompt.input,
        scenario,
      );
      const firstProvider: ProviderResult =
        provider.kind === 'completed'
          ? {
              ...provider,
              result: {
                ...provider.result,
                action: 'CONTINUE',
                leadDecision: 'NOT_READY',
                shouldCreateLead: false,
                shouldCloseConversation: false,
              },
            }
          : provider;
      return await this.decisions.apply(run.id, conversationId, firstProvider);
    } catch (error) {
      return await this.handleProviderError(run.id, error);
    } finally {
      await this.completeRunMetrics(run.id);
    }
  }

  async processClientMessage(
    conversationId: string,
    clientMessageId: string,
    scenarioValue?: string,
    aggregatedMessageIds: string[] = [clientMessageId],
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: { select: { deletedAt: true } } },
    });
    if (!conversation) throw new NotFoundException('Разговор не найден');
    if (conversation.contact.deletedAt) {
      throw new ForbiddenException('Контакт удалён');
    }
    if (isTerminalConversationStatus(conversation.status)) {
      throw new ConflictException(
        `Автоматизация запрещена для диалога ${conversation.status}`,
      );
    }
    const message = await this.prisma.message.findFirst({
      where: { id: clientMessageId, conversationId, role: MessageRole.CLIENT },
    });
    if (!message) throw new NotFoundException('Сообщение клиента не найдено');
    const processed = await this.prisma.aiRun.findFirst({
      where: { conversationId, triggerMessageId: clientMessageId },
      select: { id: true },
    });
    if (processed) throw new ConflictException('Сообщение уже обработано');

    await this.language.updateFromClientMessage(conversationId, message.text);
    const scenario = this.config.parseDebugScenario(scenarioValue);
    const prompt = await this.prompts.build(conversationId);
    const aiMessages = await this.prisma.message.count({
      where: { conversationId, role: MessageRole.AI },
    });
    if (aiMessages >= prompt.maxAssistantMessages) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: ConversationStatus.HANDOFF_REQUIRED },
      });
      throw new ConflictException(
        'Достигнут лимит автоматических сообщений. Требуется участие менеджера',
      );
    }

    let run: { id: string };
    try {
      run = await this.createRun(
        conversationId,
        clientMessageId,
        prompt,
        aggregatedMessageIds,
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Сообщение уже обработано');
      }
      throw error;
    }
    try {
      const provider = await this.generateWithMetrics(
        run.id,
        prompt.systemPrompt,
        prompt.input,
        scenario,
      );
      return await this.decisions.apply(run.id, conversationId, provider);
    } catch (error) {
      return await this.handleProviderError(run.id, error);
    } finally {
      await this.completeRunMetrics(run.id);
    }
  }

  async previewContext(conversationId: string) {
    if (process.env.NODE_ENV === 'production') {
      throw new NotFoundException('Маршрут не найден');
    }
    return this.prompts.build(conversationId);
  }

  async findRuns(conversationId: string, query: AiRunsQueryDto) {
    const exists = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Разговор не найден');
    const where = { conversationId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.aiRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          triggerMessageId: true,
          model: true,
          status: true,
          action: true,
          leadDecision: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          estimatedCostUsd: true,
          latencyMs: true,
          errorCode: true,
          createdAt: true,
          completedAt: true,
        },
      }),
      this.prisma.aiRun.count({ where }),
    ]);
    return {
      data,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async findRun(id: string) {
    const run = await this.prisma.aiRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('AI-запуск не найден');
    return run;
  }

  hasProcessedMessage(conversationId: string, messageId: string) {
    return this.prisma.aiRun.findFirst({
      where: {
        conversationId,
        OR: [
          { triggerMessageId: messageId },
          { processedMessages: { some: { id: messageId } } },
        ],
      },
    });
  }

  get configured() {
    return this.config.configured;
  }

  private createRun(
    conversationId: string,
    triggerMessageId: string | null,
    prompt: { promptStrategyId: string; promptVersionId: string },
    aggregatedMessageIds: string[] = [],
  ) {
    const messageIds = [...new Set(aggregatedMessageIds)];
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.aiRun.create({
        data: {
          conversationId,
          triggerMessageId,
          promptStrategyId: prompt.promptStrategyId,
          promptVersionId: prompt.promptVersionId,
          model: this.config.providerModel,
          startedAt: new Date(),
        },
      });
      const claimed = await tx.message.updateMany({
        where: {
          id: { in: messageIds },
          conversationId,
          role: MessageRole.CLIENT,
          aiRunId: null,
        },
        data: { aiRunId: run.id },
      });
      if (claimed.count !== messageIds.length)
        throw new ConflictException(
          'One or more messages were already processed',
        );
      return run;
    });
  }

  private async generateWithMetrics(
    aiRunId: string,
    systemPrompt: string,
    input: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>,
    scenario: Parameters<OpenAiService['generate']>[2],
  ) {
    const startedAt = new Date();
    await this.prisma.aiRun.update({
      where: { id: aiRunId },
      data: { openAiStartedAt: startedAt },
    });
    try {
      const provider = await this.openAi.generate(
        systemPrompt,
        input,
        scenario,
      );
      await this.prisma.aiRun.update({
        where: { id: aiRunId },
        data: { providerAttempts: provider.attempts },
      });
      return provider;
    } catch (error) {
      await this.prisma.aiRun.update({
        where: { id: aiRunId },
        data: {
          providerAttempts:
            error instanceof AiProviderError ? error.attempts : 1,
        },
      });
      throw error;
    } finally {
      const finishedAt = new Date();
      await this.prisma.aiRun.update({
        where: { id: aiRunId },
        data: {
          openAiFinishedAt: finishedAt,
          openAiDurationMs: finishedAt.getTime() - startedAt.getTime(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        },
      });
    }
  }

  private async completeRunMetrics(aiRunId: string) {
    const run = await this.prisma.aiRun.findUnique({
      where: { id: aiRunId },
      select: { startedAt: true },
    });
    if (!run?.startedAt) return;
    await this.prisma.aiRun.update({
      where: { id: aiRunId },
      data: { durationMs: Date.now() - run.startedAt.getTime() },
    });
  }

  private async handleProviderError(
    aiRunId: string,
    error: unknown,
  ): Promise<never> {
    const providerError =
      error instanceof AiProviderError
        ? error
        : new AiProviderError(
            'UNAVAILABLE',
            'Unexpected provider error',
            false,
          );
    await this.decisions.fail(
      aiRunId,
      providerError.code,
      providerError.message,
    );
    if (providerError.code === 'TIMEOUT') {
      throw new RequestTimeoutException(
        'Запрос к OpenAI превысил время ожидания',
        { cause: providerError },
      );
    }
    if (providerError.code === 'INVALID_OUTPUT') {
      throw new BadGatewayException('OpenAI не вернул корректный результат', {
        cause: providerError,
      });
    }
    throw new ServiceUnavailableException('OpenAI временно недоступен', {
      cause: providerError,
    });
  }
}
