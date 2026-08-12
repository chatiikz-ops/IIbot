import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClassificationService } from '../classification/classification.service';
import { ImportRowStatus, ImportStatus } from '../generated/prisma/enums';
import { Prisma } from '../generated/prisma/client';
import { normalizePhone } from '../common/utils/phone.util';
import { PrismaService } from '../prisma/prisma.service';
import type { ImportRowsQueryDto } from './dto/import-rows-query.dto';
import {
  IMPORT_FIELDS,
  MAPPING_FIELDS,
  type ColumnMapping,
  type ImportField,
  type NormalizedContactData,
  type RawImportRow,
} from './imports.types';
import { detectColumnMapping } from './utils/column-mapping.util';
import { parseSpreadsheet } from './utils/spreadsheet.util';

type SourceRow = { rowNumber: number; rawData: RawImportRow };
type ProcessedRow = SourceRow & {
  status: ImportRowStatus;
  normalizedData: NormalizedContactData | null;
  errors: string[];
};

@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly classificationService: ClassificationService,
  ) {}

  async preview(file?: Express.Multer.File) {
    const { headers, rows } = parseSpreadsheet(file);
    const detected = detectColumnMapping(headers);
    const processed = await this.processRows(rows, detected.mapping);
    const counts = this.countRows(processed);
    const ready = this.hasRequiredMapping(detected.mapping);

    const job = await this.prisma.$transaction(async (tx) => {
      const created = await tx.importJob.create({
        data: {
          fileName: file!.originalname,
          status: ready ? ImportStatus.READY : ImportStatus.PREVIEW,
          totalRows: processed.length,
          validRows: counts.valid,
          invalidRows: counts.invalid,
          duplicateRows: counts.duplicateInFile + counts.duplicateInDatabase,
          columnMapping: detected.mapping,
        },
      });

      for (const batch of this.chunk(processed, 1_000)) {
        await tx.importRow.createMany({
          data: batch.map((row) => this.toImportRowCreate(created.id, row)),
        });
      }

      return created;
    });

    return {
      importId: job.id,
      fileName: job.fileName,
      detectedColumns: headers,
      mapping: detected.mapping,
      unmappedColumns: detected.unmappedColumns,
      ambiguousColumns: detected.ambiguousColumns,
      summary: { total: processed.length, ...counts },
      previewRows: processed.slice(0, 20),
    };
  }

  async updateMapping(id: string, mappingInput: Record<string, string>) {
    const job = await this.getJob(id);
    if (job.status === ImportStatus.COMPLETED) {
      throw new ConflictException('Импорт уже завершён');
    }

    const rows = await this.prisma.importRow.findMany({
      where: { importJobId: id },
      orderBy: { rowNumber: 'asc' },
    });
    const headers = Object.keys((rows[0]?.rawData ?? {}) as RawImportRow);
    const mapping = this.validateMapping(mappingInput, headers);
    const processed = await this.processRows(
      rows.map((row) => ({
        rowNumber: row.rowNumber,
        rawData: row.rawData as RawImportRow,
      })),
      mapping,
    );
    const counts = this.countRows(processed);

    await this.prisma.$transaction(async (tx) => {
      for (const row of processed) {
        await tx.importRow.update({
          where: {
            importJobId_rowNumber: {
              importJobId: id,
              rowNumber: row.rowNumber,
            },
          },
          data: this.toImportRowUpdate(row),
        });
      }

      await tx.importJob.update({
        where: { id },
        data: {
          status: this.hasRequiredMapping(mapping)
            ? ImportStatus.READY
            : ImportStatus.PREVIEW,
          columnMapping: mapping,
          validRows: counts.valid,
          invalidRows: counts.invalid,
          duplicateRows: counts.duplicateInFile + counts.duplicateInDatabase,
          errorMessage: null,
        },
      });
    });

    return this.buildPreviewResponse(id);
  }

  async findOne(id: string) {
    await this.getJob(id);
    return this.buildPreviewResponse(id);
  }

  async findRows(id: string, query: ImportRowsQueryDto) {
    await this.getJob(id);
    const where: Prisma.ImportRowWhereInput = {
      importJobId: id,
      status: query.status,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.importRow.findMany({
        where,
        orderBy: { rowNumber: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.importRow.count({ where }),
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

  async confirm(id: string) {
    const job = await this.getJob(id);
    if (job.status === ImportStatus.COMPLETED) {
      return this.buildConfirmResponse(id);
    }

    const mapping = job.columnMapping as ColumnMapping;
    if (!Object.values(mapping).includes('companyName')) {
      throw new BadRequestException(
        'Не удалось определить колонку с названием компании',
      );
    }
    if (!Object.values(mapping).includes('phone')) {
      throw new BadRequestException(
        'Не удалось определить колонку с телефоном',
      );
    }

    const claimed = await this.prisma.importJob.updateMany({
      where: {
        id,
        status: {
          in: [ImportStatus.PREVIEW, ImportStatus.READY, ImportStatus.FAILED],
        },
      },
      data: { status: ImportStatus.IMPORTING, errorMessage: null },
    });
    if (claimed.count === 0) {
      throw new ConflictException('Импорт уже выполняется');
    }

    const createdContactIds: string[] = [];

    try {
      const rows = await this.prisma.importRow.findMany({
        where: { importJobId: id, status: ImportRowStatus.VALID },
        orderBy: { rowNumber: 'asc' },
      });

      for (const batch of this.chunk(rows, 500)) {
        await this.prisma.$transaction(async (tx) => {
          const normalizedRows = batch.map((row) => ({
            row,
            data: row.normalizedData as NormalizedContactData,
          }));
          const phones = normalizedRows.map(({ data }) => data.phone);
          const existing = await tx.contact.findMany({
            where: { phone: { in: phones } },
            select: { phone: true },
          });
          const existingPhones = new Set(existing.map(({ phone }) => phone));
          const rowsToCreate = normalizedRows.filter(
            ({ data }) => !existingPhones.has(data.phone),
          );

          if (rowsToCreate.length > 0) {
            const created = await tx.contact.createManyAndReturn({
              data: rowsToCreate.map(({ row, data }) => ({
                ...data,
                rawData: row.rawData as Prisma.InputJsonValue,
              })),
              select: { id: true, phone: true },
            });
            const contactsByPhone = new Map(
              created.map((contact) => [contact.phone, contact.id]),
            );
            createdContactIds.push(
              ...created.map(({ id: contactId }) => contactId),
            );

            for (const { row, data } of rowsToCreate) {
              await tx.importRow.update({
                where: { id: row.id },
                data: {
                  status: ImportRowStatus.IMPORTED,
                  contactId: contactsByPhone.get(data.phone),
                },
              });
            }
          }

          if (existingPhones.size > 0) {
            await tx.importRow.updateMany({
              where: {
                id: {
                  in: normalizedRows
                    .filter(({ data }) => existingPhones.has(data.phone))
                    .map(({ row }) => row.id),
                },
              },
              data: { status: ImportRowStatus.DUPLICATE_IN_DATABASE },
            });
          }
        });
      }

      const importedRows = await this.prisma.importRow.count({
        where: { importJobId: id, status: ImportRowStatus.IMPORTED },
      });
      await this.prisma.importJob.update({
        where: { id },
        data: { status: ImportStatus.COMPLETED, importedRows },
      });

      try {
        await this.classificationService.classifyContactIds(createdContactIds);
      } catch {
        this.logger.error('Post-import classification failed');
      }

      return this.buildConfirmResponse(id);
    } catch (error) {
      await this.prisma.importJob.update({
        where: { id },
        data: {
          status: ImportStatus.FAILED,
          errorMessage: 'Не удалось завершить импорт',
        },
      });
      throw new InternalServerErrorException('Не удалось завершить импорт', {
        cause: error,
      });
    }
  }

  async remove(id: string) {
    try {
      return await this.prisma.importJob.delete({ where: { id } });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Импорт не найден');
      }
      throw error;
    }
  }

  private async processRows(rows: SourceRow[], mapping: ColumnMapping) {
    const preliminarilyProcessed = rows.map((row) =>
      this.normalizeRow(row, mapping),
    );
    const phones = preliminarilyProcessed
      .map((row) => row.normalizedData?.phone)
      .filter((phone): phone is string => Boolean(phone));
    const existingPhones = new Set<string>();

    for (const batch of this.chunk([...new Set(phones)], 5_000)) {
      const contacts = await this.prisma.contact.findMany({
        where: { phone: { in: batch } },
        select: { phone: true },
      });
      contacts.forEach(({ phone }) => existingPhones.add(phone));
    }

    const seenPhones = new Set<string>();
    return preliminarilyProcessed.map((row): ProcessedRow => {
      const phone = row.normalizedData?.phone;
      if (!phone || row.errors.length > 0) {
        if (phone) seenPhones.add(phone);
        return { ...row, status: ImportRowStatus.INVALID };
      }
      if (seenPhones.has(phone)) {
        return { ...row, status: ImportRowStatus.DUPLICATE_IN_FILE };
      }
      seenPhones.add(phone);
      if (existingPhones.has(phone)) {
        return { ...row, status: ImportRowStatus.DUPLICATE_IN_DATABASE };
      }
      return { ...row, status: ImportRowStatus.VALID };
    });
  }

  private normalizeRow(row: SourceRow, mapping: ColumnMapping) {
    const mapped = Object.fromEntries(
      Object.entries(mapping)
        .filter(([, field]) => field !== 'ignore')
        .map(([header, field]) => [field, this.text(row.rawData[header])]),
    ) as Partial<Record<ImportField, string | null>>;
    const errors: string[] = [];
    const companyName = mapped.companyName ?? null;
    const phone = mapped.phone ? normalizePhone(mapped.phone) : null;

    if (!companyName) errors.push('Не указано название компании');
    if (!mapped.phone) errors.push('Не указан телефон');
    else if (!phone) errors.push('Некорректный номер телефона');

    const website = this.normalizeUrl(mapped.website, 'website', errors);
    const instagram = this.normalizeInstagram(mapped.instagram, errors);
    const twoGisUrl = this.normalizeUrl(mapped.twoGisUrl, 'twoGisUrl', errors);
    const bookingUrl = this.normalizeUrl(
      mapped.bookingUrl,
      'bookingUrl',
      errors,
    );

    const normalizedData =
      companyName && phone
        ? {
            companyName,
            phone,
            city: mapped.city ?? null,
            category: mapped.category ?? null,
            website,
            instagram,
            twoGisUrl,
            bookingUrl,
            email: mapped.email ?? null,
            address: mapped.address ?? null,
            notes: mapped.notes ?? null,
          }
        : null;

    return { ...row, normalizedData, errors };
  }

  private normalizeUrl(
    value: string | null | undefined,
    field: string,
    errors: string[],
  ): string | null {
    if (!value) return null;
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const url = new URL(candidate);
      if (!url.hostname.includes('.')) throw new Error();
      return url.toString();
    } catch {
      errors.push(`Некорректный URL в поле ${field}`);
      return null;
    }
  }

  private normalizeInstagram(
    value: string | null | undefined,
    errors: string[],
  ) {
    if (!value) return null;
    if (value.startsWith('@')) {
      const handle = value.slice(1).trim();
      if (/^[a-zA-Z0-9._]+$/.test(handle)) {
        return `https://instagram.com/${handle}`;
      }
    }
    return this.normalizeUrl(value, 'instagram', errors);
  }

  private validateMapping(input: Record<string, string>, headers: string[]) {
    const mapping: ColumnMapping = {};
    const used = new Set<string>();
    for (const [header, field] of Object.entries(input)) {
      if (
        !headers.includes(header) ||
        !MAPPING_FIELDS.includes(field as never)
      ) {
        throw new BadRequestException('Сопоставление колонок содержит ошибки');
      }
      if (field !== 'ignore' && used.has(field)) {
        throw new BadRequestException('Сопоставление колонок содержит ошибки');
      }
      if (field !== 'ignore') used.add(field);
      mapping[header] = field as ColumnMapping[string];
    }
    return mapping;
  }

  private async buildPreviewResponse(id: string) {
    const job = await this.prisma.importJob.findUnique({
      where: { id },
      include: { rows: { orderBy: { rowNumber: 'asc' }, take: 20 } },
    });
    if (!job) throw new NotFoundException('Импорт не найден');
    const headers = Object.keys((job.rows[0]?.rawData ?? {}) as RawImportRow);
    const mapping = job.columnMapping as ColumnMapping;
    const counts = await this.countStoredRows(id);
    return {
      importId: job.id,
      fileName: job.fileName,
      status: job.status,
      detectedColumns: headers,
      mapping,
      unmappedColumns: headers.filter((header) => !mapping[header]),
      ambiguousColumns: [],
      summary: { total: job.totalRows, ...counts },
      previewRows: job.rows,
    };
  }

  private async buildConfirmResponse(id: string) {
    const job = await this.getJob(id);
    const counts = await this.countStoredRows(id);
    return {
      importId: id,
      status: job.status,
      summary: {
        total: job.totalRows,
        imported: counts.imported,
        invalid: counts.invalid,
        duplicateInFile: counts.duplicateInFile,
        duplicateInDatabase: counts.duplicateInDatabase,
      },
    };
  }

  private async countStoredRows(importJobId: string) {
    const groups = await this.prisma.importRow.groupBy({
      by: ['status'],
      where: { importJobId },
      _count: true,
    });
    const count = (status: ImportRowStatus) =>
      groups.find((group) => group.status === status)?._count ?? 0;
    return {
      valid: count(ImportRowStatus.VALID),
      invalid: count(ImportRowStatus.INVALID),
      duplicateInFile: count(ImportRowStatus.DUPLICATE_IN_FILE),
      duplicateInDatabase: count(ImportRowStatus.DUPLICATE_IN_DATABASE),
      imported: count(ImportRowStatus.IMPORTED),
    };
  }

  private countRows(rows: ProcessedRow[]) {
    const count = (status: ImportRowStatus) =>
      rows.filter((row) => row.status === status).length;
    return {
      valid: count(ImportRowStatus.VALID),
      invalid: count(ImportRowStatus.INVALID),
      duplicateInFile: count(ImportRowStatus.DUPLICATE_IN_FILE),
      duplicateInDatabase: count(ImportRowStatus.DUPLICATE_IN_DATABASE),
    };
  }

  private toImportRowCreate(importJobId: string, row: ProcessedRow) {
    return {
      importJobId,
      rowNumber: row.rowNumber,
      status: row.status,
      rawData: row.rawData as Prisma.InputJsonValue,
      ...(row.normalizedData
        ? { normalizedData: row.normalizedData as Prisma.InputJsonValue }
        : {}),
      ...(row.errors.length
        ? { errors: row.errors as Prisma.InputJsonValue }
        : {}),
    };
  }

  private toImportRowUpdate(row: ProcessedRow) {
    return {
      status: row.status,
      normalizedData: row.normalizedData
        ? (row.normalizedData as Prisma.InputJsonValue)
        : Prisma.DbNull,
      errors: row.errors.length
        ? (row.errors as Prisma.InputJsonValue)
        : Prisma.DbNull,
      contactId: null,
    };
  }

  private hasRequiredMapping(mapping: ColumnMapping) {
    const values = Object.values(mapping);
    return values.includes('companyName') && values.includes('phone');
  }

  private text(value: string | null | undefined) {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private async getJob(id: string) {
    const job = await this.prisma.importJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Импорт не найден');
    return job;
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }
}
