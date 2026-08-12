import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { AutomationEventType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { AutomationEventsQueryDto } from './dto/automation-events-query.dto';

export type CreateAutomationEvent = {
  type: AutomationEventType;
  contactId?: string;
  conversationId?: string;
  messageId?: string;
  aiRunId?: string;
  whatsAppMessageId?: string;
  reason?: string;
  metadata?: Prisma.InputJsonObject;
};

@Injectable()
export class AutomationEventsService {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateAutomationEvent) {
    return this.prisma.automationEvent.create({ data });
  }

  async findAll(query: AutomationEventsQueryDto) {
    const where: Prisma.AutomationEventWhereInput = {
      conversationId: query.conversationId,
      type: query.type,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.automationEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.automationEvent.count({ where }),
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
}
