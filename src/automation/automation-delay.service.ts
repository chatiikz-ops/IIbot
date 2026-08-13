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
    const job = await this.prisma.automationJob.upsert({
      where: { deduplicationKey: `conversation-reply:${input.messageId}` },
      create: {
        type: AutomationJobType.CONVERSATION_REPLY,
        runAt: new Date(Date.now() + delaySeconds * 1000),
        contactId: input.contactId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        deduplicationKey: `conversation-reply:${input.messageId}`,
        payload: { ...input, mockScenario },
      },
      update: {},
    });
    return job.attempts === 0 && job.status === 'PENDING';
  }

  get pendingCount() {
    return this.prisma.automationJob.count({ where: { status: 'PENDING' } });
  }
}
