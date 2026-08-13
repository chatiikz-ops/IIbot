import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { normalizePhone } from '../common/utils/phone.util';
import {
  normalizeHttpUrl,
  normalizeInstagram,
} from '../common/utils/contact-normalization.util';
import { ClassificationService } from '../classification/classification.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ContactsQueryDto } from './dto/contacts-query.dto';
import type { CreateContactDto } from './dto/create-contact.dto';
import type { UpdateContactDto } from './dto/update-contact.dto';
import type { DeletedContactsQueryDto } from './dto/deleted-contacts-query.dto';

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly classificationService: ClassificationService,
  ) {}

  async create(data: CreateContactDto) {
    const phone = this.getNormalizedPhone(data.phone);

    try {
      const contact = await this.prisma.contact.create({
        data: this.normalizeData({ ...data, phone }),
      });
      try {
        return await this.classificationService.classifyContact(contact.id);
      } catch (error) {
        this.logger.error('Contact created, but classification failed', error);
        return contact;
      }
    } catch (error) {
      this.handlePrismaError(error);
    }
  }

  async findAll(query: ContactsQueryDto) {
    const {
      page,
      limit,
      search,
      status,
      crmProvider,
      businessType,
      outreachEligible,
      strategyCode,
      city,
    } = query;
    const where: Prisma.ContactWhereInput = {
      deletedAt: null,
      status,
      crmProvider,
      businessType,
      outreachEligible,
      strategyCode,
      ...(city ? { city: { equals: city, mode: 'insensitive' } } : {}),
      ...(search
        ? {
            OR: [
              { companyName: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { city: { contains: search, mode: 'insensitive' } },
              { category: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { address: { contains: search, mode: 'insensitive' } },
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

  async findDeleted(query: DeletedContactsQueryDto) {
    const { page, limit, search } = query;
    const where: Prisma.ContactWhereInput = {
      deletedAt: { not: null },
      ...(search
        ? {
            OR: [
              { companyName: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { city: { contains: search, mode: 'insensitive' } },
              { category: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { address: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.contact.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { deletedAt: 'desc' },
      }),
      this.prisma.contact.count({ where }),
    ]);
    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    const contact = await this.prisma.contact.findFirst({
      where: { id, deletedAt: null },
    });

    if (!contact) {
      throw new NotFoundException('Контакт не найден');
    }

    return contact;
  }

  async update(id: string, data: UpdateContactDto) {
    const phone = data.phone ? this.getNormalizedPhone(data.phone) : undefined;

    try {
      const contact = await this.prisma.contact.update({
        where: { id, deletedAt: null },
        data: {
          ...this.normalizeData(data),
          ...(phone ? { phone } : {}),
        },
      });
      const sensitive = [
        'companyName',
        'category',
        'website',
        'instagram',
        'twoGisUrl',
        'bookingUrl',
      ];
      return sensitive.some((field) =>
        Object.prototype.hasOwnProperty.call(data, field),
      )
        ? await this.classificationService.classifyContact(contact.id)
        : contact;
    } catch (error) {
      this.handlePrismaError(error);
    }
  }

  async remove(id: string) {
    try {
      return await this.prisma.contact.update({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date(), deletedBy: null, deletionReason: null },
      });
    } catch (error) {
      this.handlePrismaError(error);
    }
  }

  async restore(id: string) {
    const contact = await this.prisma.contact.findFirst({
      where: { id, deletedAt: { not: null } },
    });
    if (!contact) throw new NotFoundException('Контакт не найден');
    const conflicting = await this.prisma.contact.findFirst({
      where: { phone: contact.phone, deletedAt: null, id: { not: id } },
      select: { id: true },
    });
    if (conflicting) {
      throw new ConflictException(
        'Невозможно восстановить контакт: номер телефона уже используется',
      );
    }
    try {
      return await this.prisma.contact.update({
        where: { id, deletedAt: { not: null } },
        data: { deletedAt: null, deletedBy: null, deletionReason: null },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Невозможно восстановить контакт: номер телефона уже используется',
        );
      }
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

  private normalizeData<T extends CreateContactDto | UpdateContactDto>(
    data: T,
  ): T {
    const normalized = { ...data };
    const labels: Record<string, string> = {
      website: 'Некорректный адрес сайта',
      twoGisUrl: 'Некорректная ссылка 2GIS',
      bookingUrl: 'Некорректная ссылка записи',
    };
    for (const field of ['website', 'twoGisUrl', 'bookingUrl'] as const) {
      const value = normalized[field];
      if (typeof value !== 'string') continue;
      const url = normalizeHttpUrl(value);
      if (!url) throw new BadRequestException(labels[field]);
      Object.assign(normalized, { [field]: url });
    }
    if (typeof normalized.instagram === 'string') {
      const instagram = normalizeInstagram(normalized.instagram);
      if (!instagram)
        throw new BadRequestException('Некорректная ссылка Instagram');
      Object.assign(normalized, { instagram });
    }
    if (typeof normalized.companyName === 'string')
      normalized.companyName = normalized.companyName.trim();
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
