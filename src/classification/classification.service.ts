import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CrmProvider,
  ImportRowStatus,
  OutreachSkipReason,
} from '../generated/prisma/enums';
import type { Contact } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  detectBusinessType,
  detectCrmProvider,
  determineStrategy,
} from './utils/classification.util';
import { extractDomain, extractDomains } from './utils/domain.util';
import { SYSTEM_STRATEGY_CODES } from '../prompt-strategies/prompt-strategies.constants';

@Injectable()
export class ClassificationService {
  private readonly logger = new Logger(ClassificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async classifyContact(id: string) {
    const contact = await this.prisma.contact.findFirst({
      where: { id, deletedAt: null },
    });
    if (!contact) throw new NotFoundException('Контакт не найден');
    return this.classifyAndSave(contact);
  }

  async classifyImport(importId: string) {
    const job = await this.prisma.importJob.findUnique({
      where: { id: importId },
      select: { id: true },
    });
    if (!job) throw new NotFoundException('Импорт не найден');

    const rows = await this.prisma.importRow.findMany({
      where: {
        importJobId: importId,
        status: ImportRowStatus.IMPORTED,
        contactId: { not: null },
      },
      select: { contactId: true },
      distinct: ['contactId'],
    });
    return this.classifyContactIds(
      rows.flatMap(({ contactId }) => (contactId ? [contactId] : [])),
    );
  }

  async classifyAll(force = false) {
    const totals: Array<{ processed: number }> = [];
    let cursor: string | undefined;
    for (;;) {
      const contacts = await this.prisma.contact.findMany({
        where: force
          ? { deletedAt: null }
          : { classifiedAt: null, deletedAt: null },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!contacts.length) break;
      totals.push(await this.classifyContactIds(contacts.map(({ id }) => id)));
      cursor = contacts.at(-1)!.id;
    }
    return {
      batches: totals.length,
      processed: totals.reduce((sum, item) => sum + item.processed, 0),
    };
  }

  async classifyContactIds(ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    const classified: Contact[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += 500) {
      const batchIds = uniqueIds.slice(offset, offset + 500);
      this.logger.log({
        event: 'CLASSIFICATION_BATCH_STARTED',
        size: batchIds.length,
        offset,
      });
      const contacts = await this.prisma.contact.findMany({
        where: { id: { in: batchIds }, deletedAt: null },
      });
      for (let index = 0; index < contacts.length; index += 10) {
        const results = await Promise.allSettled(
          contacts
            .slice(index, index + 10)
            .map((contact) => this.classifyAndSave(contact)),
        );
        results.forEach((result, resultIndex) => {
          const contact = contacts[index + resultIndex];
          if (result.status === 'fulfilled') {
            classified.push(result.value);
            this.logger.debug({
              event: 'STRATEGY_ASSIGNED',
              contactId: contact.id,
              strategyCode: result.value.strategyCode,
            });
          } else {
            this.logger.error({
              event: 'STRATEGY_ASSIGNMENT_FAILED',
              contactId: contact.id,
              errorCode:
                result.reason instanceof Error ? result.reason.name : 'UNKNOWN',
            });
            this.logger.error({
              event: 'CLASSIFICATION_FAILED',
              contactId: contact.id,
              errorCode:
                result.reason instanceof Error ? result.reason.name : 'UNKNOWN',
              reason:
                result.reason instanceof Error
                  ? result.reason.message.slice(0, 300)
                  : 'unknown',
            });
          }
        });
      }
      this.logger.log({
        event: 'CLASSIFICATION_BATCH_COMPLETED',
        size: batchIds.length,
        classified: classified.length,
        offset,
      });
    }

    return this.summarize(classified);
  }

  async getStats() {
    const [
      crm,
      business,
      strategies,
      outreach,
      skipReasons,
      total,
      classified,
      strategyAssigned,
    ] = await Promise.all([
      this.prisma.contact.groupBy({
        by: ['crmProvider'],
        where: { deletedAt: null },
        _count: true,
      }),
      this.prisma.contact.groupBy({
        by: ['businessType'],
        where: { deletedAt: null },
        _count: true,
      }),
      this.prisma.contact.groupBy({
        by: ['strategyCode'],
        where: { deletedAt: null },
        _count: true,
      }),
      this.prisma.contact.groupBy({
        by: ['outreachEligible'],
        where: { deletedAt: null },
        _count: true,
      }),
      this.prisma.contact.groupBy({
        by: ['skipReason'],
        where: { deletedAt: null },
        _count: true,
      }),
      this.prisma.contact.count({ where: { deletedAt: null } }),
      this.prisma.contact.count({
        where: { deletedAt: null, classifiedAt: { not: null } },
      }),
      this.prisma.contact.count({
        where: { deletedAt: null, strategyCode: { not: null } },
      }),
    ]);

    return {
      crmProvider: Object.fromEntries(
        crm.map((row) => [row.crmProvider, row._count]),
      ),
      businessType: Object.fromEntries(
        business.map((row) => [row.businessType, row._count]),
      ),
      strategyCode: Object.fromEntries(
        strategies.map((row) => [row.strategyCode ?? 'NONE', row._count]),
      ),
      outreachEligible: Object.fromEntries(
        outreach.map((row) => [String(row.outreachEligible), row._count]),
      ),
      skipReason: Object.fromEntries(
        skipReasons.map((row) => [row.skipReason ?? 'NONE', row._count]),
      ),
      totals: {
        total,
        classified,
        unclassified: total - classified,
        strategyAssigned,
        strategyMissing: total - strategyAssigned,
        strategyInvalid: strategies.reduce(
          (sum, row) =>
            row.strategyCode &&
            !(SYSTEM_STRATEGY_CODES as readonly string[]).includes(
              row.strategyCode,
            )
              ? sum + row._count
              : sum,
          0,
        ),
      },
    };
  }

  private async classifyAndSave(contact: Contact) {
    const rawValues = this.rawStringValues(contact.rawData);
    const domains = extractDomains([
      contact.website,
      contact.bookingUrl,
      contact.instagram,
      contact.twoGisUrl,
      ...rawValues,
    ]);
    const crmProvider = detectCrmProvider(
      domains,
      extractDomain(contact.bookingUrl),
    );
    const businessType = detectBusinessType([
      contact.category,
      contact.companyName,
      ...rawValues,
    ]);
    const strategyCode = determineStrategy(businessType, crmProvider);
    const isZapis = crmProvider === CrmProvider.ZAPIS;
    const preserveManualSkip =
      contact.skipReason === OutreachSkipReason.MANUALLY_EXCLUDED ||
      contact.skipReason === OutreachSkipReason.MISSING_PHONE;

    return this.prisma.contact.update({
      where: { id: contact.id, deletedAt: null },
      data: {
        crmProvider,
        businessType,
        strategyCode,
        detectedDomains: domains,
        classifiedAt: new Date(),
        outreachEligible: isZapis
          ? false
          : preserveManualSkip
            ? contact.outreachEligible
            : true,
        skipReason: isZapis
          ? OutreachSkipReason.EXISTING_ZAPIS_CLIENT
          : preserveManualSkip
            ? contact.skipReason
            : null,
      },
    });
  }

  private summarize(contacts: Contact[]) {
    const businessTypes: Record<string, number> = {};
    const strategies: Record<string, number> = {};
    let zapisClientsSkipped = 0;
    let competitorUsers = 0;
    let unknownCrm = 0;

    for (const contact of contacts) {
      businessTypes[contact.businessType] =
        (businessTypes[contact.businessType] ?? 0) + 1;
      const strategy = contact.strategyCode ?? 'NONE';
      strategies[strategy] = (strategies[strategy] ?? 0) + 1;
      if (contact.crmProvider === CrmProvider.ZAPIS) zapisClientsSkipped += 1;
      else if (contact.crmProvider === CrmProvider.UNKNOWN) unknownCrm += 1;
      else competitorUsers += 1;
    }

    return {
      processed: contacts.length,
      zapisClientsSkipped,
      competitorUsers,
      unknownCrm,
      businessTypes,
      strategies,
    };
  }

  private rawStringValues(rawData: unknown): string[] {
    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
      return [];
    }
    return Object.values(rawData).filter(
      (value): value is string => typeof value === 'string',
    );
  }
}
