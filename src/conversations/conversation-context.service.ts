import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromptStrategiesService } from '../prompt-strategies/prompt-strategies.service';

@Injectable()
export class ConversationContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promptStrategies: PromptStrategiesService,
  ) {}

  async buildConversationContext(conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        contact: true,
        messages: { orderBy: { createdAt: 'asc' } },
        lead: true,
      },
    });
    if (!conversation) throw new NotFoundException('Разговор не найден');

    let activePromptStrategy: unknown = null;
    try {
      activePromptStrategy = await this.promptStrategies.getActivePromptByCode(
        conversation.strategyCode,
      );
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
    }

    return {
      conversation,
      contact: conversation.contact,
      messages: conversation.messages,
      businessType: conversation.contact.businessType,
      crmProvider: conversation.contact.crmProvider,
      strategyCode: conversation.strategyCode,
      activePromptStrategy,
      lead: conversation.lead,
    };
  }
}
