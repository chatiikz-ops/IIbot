import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ConversationStatus, MessageRole } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateMessageDto } from './dto/create-message.dto';
import type { MessagesQueryDto } from './dto/messages-query.dto';

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(conversationId: string, data: CreateMessageDto) {
    return this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { id: conversationId },
      });
      if (!conversation) throw new NotFoundException('Разговор не найден');
      if (conversation.status === ConversationStatus.CLOSED) {
        throw new ConflictException(
          'Нельзя добавить сообщение в закрытый разговор',
        );
      }

      const message = await tx.message.create({
        data: {
          conversationId,
          role: data.role,
          text: data.text,
          metadata: data.metadata as Prisma.InputJsonValue | undefined,
        },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          messageCount: { increment: 1 },
          lastMessageAt: message.createdAt,
          ...(conversation.messageCount === 0
            ? { status: ConversationStatus.ACTIVE }
            : {}),
        },
      });
      return message;
    });
  }

  async findAll(conversationId: string, query: MessagesQueryDto) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true },
    });
    if (!conversation) throw new NotFoundException('Разговор не найден');

    const where = { conversationId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.message.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.message.count({ where }),
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
    const message = await this.prisma.message.findUnique({ where: { id } });
    if (!message) throw new NotFoundException('Сообщение не найдено');
    return message;
  }

  async findLatestUnprocessedClient(conversationId: string) {
    const processed = await this.prisma.aiRun.findMany({
      where: { conversationId, triggerMessageId: { not: null } },
      select: { triggerMessageId: true },
    });
    return this.prisma.message.findFirst({
      where: {
        conversationId,
        role: MessageRole.CLIENT,
        id: {
          notIn: processed.flatMap(({ triggerMessageId }) =>
            triggerMessageId ? [triggerMessageId] : [],
          ),
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  countByRole(conversationId: string, role: MessageRole) {
    return this.prisma.message.count({ where: { conversationId, role } });
  }

  findLatestByRole(conversationId: string, role: MessageRole) {
    return this.prisma.message.findFirst({
      where: { conversationId, role },
      orderBy: { createdAt: 'desc' },
    });
  }
}
