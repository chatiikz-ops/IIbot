import { Injectable } from '@nestjs/common';
import { AutomationJobType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { KnownInboundMessage } from '../whatsapp/whatsapp-messaging.service';

@Injectable()
export class AutomationDelayService {
  constructor(private readonly prisma: PrismaService) {}

  async scheduleConversation(
    input: KnownInboundMessage,
    delaySeconds: number,
    mockScenario?: string,
  ) {
    const windowMs = this.envMs('INBOUND_AGGREGATION_WINDOW_MS', 3000);
    const maxMs = this.envMs('INBOUND_AGGREGATION_MAX_MS', 8000);
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inbound-aggregation:${input.conversationId}`}))`;
      const pending = await tx.automationJob.findFirst({
        where: {
          type: AutomationJobType.CONVERSATION_REPLY,
          status: 'PENDING',
          conversationId: input.conversationId,
        },
        orderBy: { createdAt: 'desc' },
      });
      const requestedAt = now.getTime() + Math.max(delaySeconds * 1000, windowMs);
      if (pending) {
        const deadline = pending.createdAt.getTime() + maxMs;
        await tx.automationJob.update({
          where: { id: pending.id },
          data: {
            runAt: new Date(Math.min(requestedAt, deadline)),
            contactId: input.contactId,
            messageId: input.messageId,
            payload: { ...input, mockScenario },
          },
        });
        return true;
      }
      await tx.automationJob.create({
        data: {
          type: AutomationJobType.CONVERSATION_REPLY,
          runAt: new Date(requestedAt),
          contactId: input.contactId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          deduplicationKey: `conversation-reply:${input.conversationId}:${input.messageId}`,
          payload: { ...input, mockScenario },
        },
      });
      return true;
    });
  }

  get pendingCount() {
    return this.prisma.automationJob.count({ where: { status: 'PENDING' } });
  }

  private envMs(name: string, fallback: number) {
    const value = Number(process.env[name] ?? fallback);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}
