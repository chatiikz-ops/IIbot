import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { MediaQueryDto } from './dto/media-query.dto';

@Injectable()
export class MediaService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: MediaQueryDto) {
    const where: Prisma.MediaAttachmentWhereInput = {
      type: query.type,
      processingStatus: query.processingStatus,
      contactId: query.contactId,
      conversationId: query.conversationId,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.mediaAttachment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.mediaAttachment.count({ where }),
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
    const item = await this.prisma.mediaAttachment.findUnique({
      where: { id },
    });
    if (!item) throw new NotFoundException('Media attachment не найден');
    return item;
  }
}
