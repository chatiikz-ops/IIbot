import { Injectable } from '@nestjs/common';
import {
  AiRunStatus,
  ConversationStatus,
  ContactStatus,
  LeadStatus,
  MessageRole,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { AiResult } from './ai-result.schema';
import { CostCalculatorService } from './cost-calculator.service';
import type { ProviderResult } from './open-ai.service';

@Injectable()
export class AiDecisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly costs: CostCalculatorService,
  ) {}

  async apply(
    aiRunId: string,
    conversationId: string,
    provider: ProviderResult,
  ) {
    if (provider.kind === 'refused') {
      return this.prisma.$transaction(async (tx) => {
        const run = await tx.aiRun.update({
          where: { id: aiRunId },
          data: {
            status: AiRunStatus.REFUSED,
            providerResponseId: provider.responseId,
            latencyMs: provider.latencyMs,
            completedAt: new Date(),
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: { status: ConversationStatus.HANDOFF_REQUIRED },
        });
        return { run, message: null, lead: null, refused: true };
      });
    }

    const result = provider.result;
    return this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
      });
      const estimatedCost = this.costs.calculate(
        provider.usage.inputTokens,
        provider.usage.outputTokens,
      );
      const run = await tx.aiRun.update({
        where: { id: aiRunId },
        data: {
          status: AiRunStatus.COMPLETED,
          action: result.action,
          leadDecision: result.leadDecision,
          reply: result.reply,
          summary: result.summary,
          extractedData: result.extractedData,
          inputTokens: provider.usage.inputTokens,
          cachedInputTokens: provider.usage.cachedInputTokens,
          outputTokens: provider.usage.outputTokens,
          totalTokens: provider.usage.totalTokens,
          estimatedCostUsd: estimatedCost,
          latencyMs: provider.latencyMs,
          providerResponseId: provider.responseId,
          completedAt: new Date(),
        },
      });

      const message = result.reply
        ? await tx.message.create({
            data: { conversationId, role: MessageRole.AI, text: result.reply },
          })
        : null;

      let status: ConversationStatus = this.conversationStatus(result);
      let closedAt: Date | null =
        status === ConversationStatus.CLOSED ||
        status === ConversationStatus.REJECTED
          ? new Date()
          : null;
      let lead: unknown = null;

      if (result.shouldCreateLead) {
        lead = await tx.lead.upsert({
          where: { conversationId },
          create: {
            conversationId,
            contactId: conversation.contactId,
            status: LeadStatus.QUALIFIED,
            summary: result.summary ?? 'Квалифицировано AI',
            qualificationReason:
              result.qualificationReason ?? 'Положительное решение AI',
            extractedData: result.extractedData,
          },
          update: {
            status: LeadStatus.QUALIFIED,
            summary: result.summary ?? 'Квалифицировано AI',
            qualificationReason:
              result.qualificationReason ?? 'Положительное решение AI',
            extractedData: result.extractedData,
          },
        });
      }

      if (result.leadDecision === 'REJECTED') {
        status = ConversationStatus.REJECTED;
        closedAt = new Date();
        await tx.contact.update({
          where: { id: conversation.contactId },
          data: { status: ContactStatus.REJECTED },
        });
      }

      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          status,
          closedAt,
          ...(message
            ? {
                messageCount: { increment: 1 },
                lastMessageAt: message.createdAt,
              }
            : {}),
        },
      });
      return { run, message, lead, result, refused: false };
    });
  }

  async fail(aiRunId: string, code: string, message: string) {
    return this.prisma.aiRun.update({
      where: { id: aiRunId },
      data: {
        status: AiRunStatus.FAILED,
        errorCode: code,
        errorMessage: message,
        completedAt: new Date(),
      },
    });
  }

  private conversationStatus(result: AiResult): ConversationStatus {
    if (result.leadDecision === 'UNCERTAIN') {
      return ConversationStatus.HANDOFF_REQUIRED;
    }
    if (result.action === 'QUALIFY') return ConversationStatus.QUALIFIED;
    if (result.action === 'HANDOFF') return ConversationStatus.HANDOFF_REQUIRED;
    if (result.action === 'STOP') return ConversationStatus.CLOSED;
    return ConversationStatus.WAITING_CLIENT;
  }
}
