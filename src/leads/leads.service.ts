import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ConversationStatus, LeadStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateLeadDto } from './dto/create-lead.dto';
import type { LeadsQueryDto } from './dto/leads-query.dto';
import type { UpdateLeadCommentDto } from './dto/update-lead-comment.dto';
import type { UpdateLeadStatusDto } from './dto/update-lead-status.dto';

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateLeadDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.findUnique({
          where: { id: data.conversationId },
          include: { lead: { select: { id: true } } },
        });
        if (!conversation) throw new NotFoundException('Разговор не найден');
        if (conversation.lead) {
          throw new ConflictException('Лид для этого разговора уже существует');
        }
        const contactLead = await tx.lead.findFirst({
          where: { contactId: conversation.contactId },
          select: { id: true },
        });
        if (contactLead) {
          throw new ConflictException('Лид для этого контакта уже существует');
        }

        const lead = await tx.lead.create({
          data: {
            conversationId: conversation.id,
            contactId: conversation.contactId,
            summary: data.summary,
            qualificationReason: data.qualificationReason,
            extractedData: data.extractedData as
              Prisma.InputJsonValue | undefined,
            managerComment: data.managerComment,
          },
        });
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { status: ConversationStatus.QUALIFIED, closedAt: null },
        });
        return lead;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Лид для этого контакта уже существует');
      }
      throw error;
    }
  }

  async findAll(query: LeadsQueryDto) {
    const where: Prisma.LeadWhereInput = { status: query.status };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.lead.findMany({
        where,
        include: { contact: true, conversation: true },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.lead.count({ where }),
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
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: { contact: true, conversation: true },
    });
    if (!lead) throw new NotFoundException('Лид не найден');
    return lead;
  }

  async updateStatus(id: string, data: UpdateLeadStatusDto) {
    await this.ensureExists(id);
    return this.prisma.lead.update({
      where: { id },
      data: {
        status: data.status,
        transferredAt:
          data.status === LeadStatus.TRANSFERRED ? new Date() : null,
      },
    });
  }

  async updateComment(id: string, data: UpdateLeadCommentDto) {
    await this.ensureExists(id);
    return this.prisma.lead.update({
      where: { id },
      data: { managerComment: data.managerComment },
    });
  }

  private async ensureExists(id: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Лид не найден');
  }
}
