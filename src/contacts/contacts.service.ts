import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { normalizePhone } from '../common/utils/phone.util';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ContactsQueryDto } from './dto/contacts-query.dto';
import type { CreateContactDto } from './dto/create-contact.dto';
import type { UpdateContactDto } from './dto/update-contact.dto';

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateContactDto) {
    const phone = this.getNormalizedPhone(data.phone);

    try {
      return await this.prisma.contact.create({
        data: { ...data, phone },
      });
    } catch (error) {
      this.handlePrismaError(error);
    }
  }

  async findAll(query: ContactsQueryDto) {
    const { page, limit, search, status } = query;
    const where: Prisma.ContactWhereInput = {
      status,
      ...(search
        ? {
            OR: [
              { companyName: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { city: { contains: search, mode: 'insensitive' } },
              { category: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.contact.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.contact.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    const contact = await this.prisma.contact.findUnique({ where: { id } });

    if (!contact) {
      throw new NotFoundException('Контакт не найден');
    }

    return contact;
  }

  async update(id: string, data: UpdateContactDto) {
    const phone = data.phone ? this.getNormalizedPhone(data.phone) : undefined;

    try {
      return await this.prisma.contact.update({
        where: { id },
        data: {
          ...data,
          ...(phone ? { phone } : {}),
        },
      });
    } catch (error) {
      this.handlePrismaError(error);
    }
  }

  async remove(id: string) {
    try {
      return await this.prisma.contact.delete({ where: { id } });
    } catch (error) {
      this.handlePrismaError(error);
    }
  }

  private getNormalizedPhone(phone: string): string {
    const normalized = normalizePhone(phone);

    if (!normalized) {
      throw new BadRequestException('Некорректный номер телефона');
    }

    return normalized;
  }

  private handlePrismaError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new ConflictException('Контакт с таким номером уже существует');
      }

      if (error.code === 'P2025') {
        throw new NotFoundException('Контакт не найден');
      }
    }

    throw error;
  }
}
