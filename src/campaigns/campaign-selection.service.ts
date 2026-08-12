import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { CampaignSourceType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { CampaignFiltersDto } from './dto/campaign-filters.dto';

type Selection = {
  sourceType: CampaignSourceType;
  sourceImportJobId?: string;
  filters: CampaignFiltersDto;
};

@Injectable()
export class CampaignSelectionService {
  constructor(private readonly prisma: PrismaService) {}

  async count(selection: Selection) {
    return this.prisma.contact.count({
      where: await this.buildWhere(selection),
    });
  }

  async select(selection: Selection) {
    return this.prisma.contact.findMany({
      where: await this.buildWhere(selection),
      select: { id: true, strategyCode: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async buildWhere(
    selection: Selection,
  ): Promise<Prisma.ContactWhereInput> {
    const { filters } = selection;
    let sourceContactIds: string[] | undefined;

    if (selection.sourceType === CampaignSourceType.IMPORT_JOB) {
      if (!selection.sourceImportJobId) {
        throw new BadRequestException(
          'Для выбранного импорта требуется sourceImportJobId',
        );
      }
      const importJob = await this.prisma.importJob.findUnique({
        where: { id: selection.sourceImportJobId },
        select: { id: true },
      });
      if (!importJob) throw new NotFoundException('Импорт не найден');
      const rows = await this.prisma.importRow.findMany({
        where: {
          importJobId: selection.sourceImportJobId,
          contactId: { not: null },
        },
        select: { contactId: true },
      });
      sourceContactIds = rows.flatMap(({ contactId }) =>
        contactId ? [contactId] : [],
      );
    }

    return {
      ...(sourceContactIds ? { id: { in: sourceContactIds } } : {}),
      businessType: filters.businessType,
      crmProvider: filters.crmProvider,
      outreachEligible: filters.outreachEligible,
      strategyCode: filters.strategyCode,
      status: filters.contactStatus,
      ...(filters.city
        ? { city: { equals: filters.city, mode: 'insensitive' } }
        : {}),
      ...(filters.category
        ? { category: { equals: filters.category, mode: 'insensitive' } }
        : {}),
    };
  }
}
