import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ConversationStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { ConversationsQueryDto } from './dto/conversations-query.dto';
import type { CreateConversationDto } from './dto/create-conversation.dto';
import type { UpdateConversationStatusDto } from './dto/update-conversation-status.dto';

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateConversationDto) {
    const active = await this.prisma.conversation.findFirst({
      where: { contactId: data.contactId, status: ConversationStatus.ACTIVE },
      orderBy: { startedAt: 'desc' },
    });
    if (active) return active;

    const contact = await this.prisma.contact.findUnique({
      where: { id: data.contactId },
      select: { id: true },
    });
    if (!contact) throw new NotFoundException('Контакт не найден');

    if (data.promptVersionId) {
      const version = await this.prisma.promptVersion.findUnique({
        where: { id: data.promptVersionId },
        select: { strategyId: true },
      });
      if (!version) throw new NotFoundException('Версия промпта не найдена');
      if (
        data.promptStrategyId &&
        version.strategyId !== data.promptStrategyId
      ) {
        throw new BadRequestException(
          'Версия не принадлежит выбранной стратегии',
        );
      }
    }

    return this.prisma.conversation.create({
      data: {
        contactId: data.contactId,
        strategyCode: data.strategyCode,
        promptStrategyId: data.promptStrategyId,
        promptVersionId: data.promptVersionId,
        metadata: data.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async findAll(query: ConversationsQueryDto) {
    const where: Prisma.ConversationWhereInput = {
      status: query.status,
      contactId: query.contactId,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.conversation.findMany({
        where,
        include: { contact: true, lead: true },
        orderBy: { lastMessageAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.conversation.count({ where }),
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

  async findOne(id: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        contact: true,
        messages: { orderBy: { createdAt: 'asc' } },
        lead: true,
        promptStrategy: true,
        promptVersion: true,
      },
    });
    if (!conversation) throw new NotFoundException('Разговор не найден');
    return conversation;
  }

  async updateStatus(id: string, data: UpdateConversationStatusDto) {
    await this.ensureExists(id);
    return this.prisma.conversation.update({
      where: { id },
      data: {
        status: data.status,
        closedAt: data.status === ConversationStatus.CLOSED ? new Date() : null,
      },
    });
  }

  private async ensureExists(id: string) {
    const exists = await this.prisma.conversation.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Разговор не найден');
  }
}
