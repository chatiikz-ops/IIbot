import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  CampaignSourceType,
  CampaignStatus,
  CampaignTargetStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignSelectionService } from './campaign-selection.service';
import type { CampaignLogsQueryDto } from './dto/campaign-logs-query.dto';
import type { CampaignTargetsQueryDto } from './dto/campaign-targets-query.dto';
import type { CampaignsQueryDto } from './dto/campaigns-query.dto';
import type { CreateCampaignTargetDto } from './dto/create-campaign-target.dto';
import type { CreateCampaignDto } from './dto/create-campaign.dto';
import type { PreviewCampaignTargetsDto } from './dto/preview-campaign-targets.dto';
import type { UpdateCampaignTargetStatusDto } from './dto/update-campaign-target-status.dto';
import type { UpdateCampaignDto } from './dto/update-campaign.dto';

const EDITABLE_STATUSES: CampaignStatus[] = [
  CampaignStatus.DRAFT,
  CampaignStatus.SCHEDULED,
];
const DELETABLE_STATUSES: CampaignStatus[] = [
  CampaignStatus.DRAFT,
  CampaignStatus.CANCELLED,
  CampaignStatus.COMPLETED,
];
const FINISHED_STATUSES: CampaignStatus[] = [
  CampaignStatus.COMPLETED,
  CampaignStatus.CANCELLED,
];
const PROCESSED_TARGET_STATUSES = new Set<CampaignTargetStatus>([
  CampaignTargetStatus.MESSAGE_SENT,
  CampaignTargetStatus.WAITING_REPLY,
  CampaignTargetStatus.REPLIED,
  CampaignTargetStatus.LEAD,
  CampaignTargetStatus.HANDOFF,
  CampaignTargetStatus.REJECTED,
  CampaignTargetStatus.ERROR,
  CampaignTargetStatus.SKIPPED,
]);
const REPLIED_TARGET_STATUSES = new Set<CampaignTargetStatus>([
  CampaignTargetStatus.REPLIED,
  CampaignTargetStatus.LEAD,
  CampaignTargetStatus.HANDOFF,
]);

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly selection: CampaignSelectionService,
  ) {}

  async previewTargets(data: PreviewCampaignTargetsDto) {
    const count = await this.selection.count(data);
    return { count };
  }

  async create(data: CreateCampaignDto) {
    this.validateSettings(data.settings);
    const contacts = await this.selection.select(data);
    const scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;

    return this.prisma.$transaction(
      async (tx) => {
        const campaign = await tx.campaign.create({
          data: {
            name: data.name.trim(),
            description: data.description?.trim(),
            status: scheduledAt
              ? CampaignStatus.SCHEDULED
              : CampaignStatus.DRAFT,
            sourceType: data.sourceType,
            sourceImportJobId:
              data.sourceType === CampaignSourceType.IMPORT_JOB
                ? data.sourceImportJobId
                : null,
            filters: data.filters as Prisma.InputJsonValue,
            scheduledAt,
            selectedCount: contacts.length,
            settings: { create: data.settings },
          },
          include: { settings: true },
        });
        if (contacts.length > 0) {
          await tx.campaignTarget.createMany({
            data: contacts.map((contact) => ({
              campaignId: campaign.id,
              contactId: contact.id,
              status: CampaignTargetStatus.READY,
              strategyCode: contact.strategyCode,
            })),
          });
        }
        await this.log(
          tx,
          campaign.id,
          'CAMPAIGN_CREATED',
          'Кампания создана',
          {
            targetCount: contacts.length,
          },
        );
        return campaign;
      },
      { timeout: 30_000 },
    );
  }

  async findAll(query: CampaignsQueryDto) {
    const where: Prisma.CampaignWhereInput = {
      status: query.status,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.campaign.findMany({
        where,
        include: { settings: true },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.campaign.count({ where }),
    ]);
    return this.paginated(data, total, query.page, query.limit);
  }

  async findOne(id: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      include: {
        settings: true,
        targets: {
          include: { contact: true },
          orderBy: { createdAt: 'asc' },
          take: 20,
        },
        logs: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!campaign) throw new NotFoundException('Кампания не найдена');
    return campaign;
  }

  async update(id: string, data: UpdateCampaignDto) {
    const campaign = await this.getCampaign(id);
    this.assertEditable(campaign.status);
    if (data.settings) this.validateSettings(data.settings);
    const contacts = data.filters
      ? await this.selection.select({
          sourceType: campaign.sourceType,
          sourceImportJobId: campaign.sourceImportJobId ?? undefined,
          filters: data.filters,
        })
      : null;

    return this.prisma.$transaction(
      async (tx) => {
        if (contacts) {
          await tx.campaignTarget.deleteMany({ where: { campaignId: id } });
          if (contacts.length > 0) {
            await tx.campaignTarget.createMany({
              data: contacts.map((contact) => ({
                campaignId: id,
                contactId: contact.id,
                status: CampaignTargetStatus.READY,
                strategyCode: contact.strategyCode,
              })),
            });
          }
        }
        const updated = await tx.campaign.update({
          where: { id },
          data: {
            name: data.name?.trim(),
            description: data.description?.trim(),
            filters: data.filters as Prisma.InputJsonValue | undefined,
            scheduledAt: data.scheduledAt
              ? new Date(data.scheduledAt)
              : undefined,
            ...(data.scheduledAt ? { status: CampaignStatus.SCHEDULED } : {}),
            ...(contacts ? { selectedCount: contacts.length } : {}),
            ...(data.settings ? { settings: { update: data.settings } } : {}),
          },
          include: { settings: true },
        });
        await this.log(tx, id, 'CAMPAIGN_UPDATED', 'Кампания обновлена');
        return updated;
      },
      { timeout: 30_000 },
    );
  }

  async remove(id: string) {
    const campaign = await this.getCampaign(id);
    if (!DELETABLE_STATUSES.includes(campaign.status)) {
      throw new ConflictException(
        'Нельзя удалить работающую, запланированную или приостановленную кампанию',
      );
    }
    return this.prisma.campaign.delete({ where: { id } });
  }

  start(id: string) {
    return this.transition(
      id,
      [CampaignStatus.DRAFT, CampaignStatus.SCHEDULED],
      CampaignStatus.RUNNING,
      'CAMPAIGN_STARTED',
      'Кампания запущена',
    );
  }

  pause(id: string) {
    return this.transition(
      id,
      [CampaignStatus.RUNNING],
      CampaignStatus.PAUSED,
      'CAMPAIGN_PAUSED',
      'Кампания поставлена на паузу',
    );
  }

  resume(id: string) {
    return this.transition(
      id,
      [CampaignStatus.PAUSED],
      CampaignStatus.RUNNING,
      'CAMPAIGN_RESUMED',
      'Кампания продолжена',
    );
  }

  complete(id: string) {
    return this.transition(
      id,
      [CampaignStatus.RUNNING, CampaignStatus.PAUSED],
      CampaignStatus.COMPLETED,
      'CAMPAIGN_COMPLETED',
      'Кампания завершена',
    );
  }

  cancel(id: string) {
    return this.transition(
      id,
      [
        CampaignStatus.DRAFT,
        CampaignStatus.SCHEDULED,
        CampaignStatus.RUNNING,
        CampaignStatus.PAUSED,
      ],
      CampaignStatus.CANCELLED,
      'CAMPAIGN_CANCELLED',
      'Кампания отменена',
    );
  }

  async findTargets(id: string, query: CampaignTargetsQueryDto) {
    await this.getCampaign(id);
    const where: Prisma.CampaignTargetWhereInput = {
      campaignId: id,
      status: query.status,
      ...(query.search
        ? {
            contact: {
              OR: [
                {
                  companyName: { contains: query.search, mode: 'insensitive' },
                },
                { phone: { contains: query.search, mode: 'insensitive' } },
                { city: { contains: query.search, mode: 'insensitive' } },
                { category: { contains: query.search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.campaignTarget.findMany({
        where,
        include: { contact: true },
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.campaignTarget.count({ where }),
    ]);
    return this.paginated(data, total, query.page, query.limit);
  }

  async findTarget(campaignId: string, targetId: string) {
    const target = await this.prisma.campaignTarget.findFirst({
      where: { id: targetId, campaignId },
      include: { contact: true, campaign: true, conversation: true },
    });
    if (!target) throw new NotFoundException('Контакт кампании не найден');
    return target;
  }

  async findTargetById(targetId: string) {
    const target = await this.prisma.campaignTarget.findUnique({
      where: { id: targetId },
      include: { contact: true, campaign: true, conversation: true },
    });
    if (!target) throw new NotFoundException('Контакт кампании не найден');
    return target;
  }

  attachConversation(targetId: string, conversationId: string) {
    return this.prisma.campaignTarget.update({
      where: { id: targetId },
      data: { conversationId },
    });
  }

  async addTarget(campaignId: string, data: CreateCampaignTargetDto) {
    const campaign = await this.getCampaign(campaignId);
    this.assertEditable(campaign.status);
    const contact = await this.prisma.contact.findUnique({
      where: { id: data.contactId },
    });
    if (!contact) throw new NotFoundException('Контакт не найден');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const target = await tx.campaignTarget.create({
          data: {
            campaignId,
            contactId: data.contactId,
            strategyCode: data.strategyCode ?? contact.strategyCode,
            status: CampaignTargetStatus.READY,
          },
          include: { contact: true },
        });
        await this.recalculateCounters(tx, campaignId);
        await this.log(
          tx,
          campaignId,
          'TARGET_ADDED',
          'Контакт добавлен в кампанию',
          {
            targetId: target.id,
            contactId: target.contactId,
          },
          target.id,
        );
        return target;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Контакт уже добавлен в кампанию');
      }
      throw error;
    }
  }

  async updateTargetStatus(
    campaignId: string,
    targetId: string,
    data: UpdateCampaignTargetStatusDto,
  ) {
    const target = await this.findTarget(campaignId, targetId);
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.campaignTarget.update({
        where: { id: targetId },
        data: {
          status: data.status,
          errorMessage:
            data.status === CampaignTargetStatus.ERROR
              ? data.errorMessage
              : null,
          ...(data.status === CampaignTargetStatus.QUEUED
            ? { queuedAt: now }
            : {}),
          ...(data.status === CampaignTargetStatus.PROCESSING
            ? { processingStartedAt: now }
            : {}),
          ...(data.status === CampaignTargetStatus.MESSAGE_SENT
            ? { messageSentAt: now }
            : {}),
          ...(REPLIED_TARGET_STATUSES.has(data.status)
            ? { repliedAt: now }
            : {}),
          ...(PROCESSED_TARGET_STATUSES.has(data.status)
            ? { completedAt: now }
            : {}),
        },
        include: { contact: true },
      });
      await this.recalculateCounters(tx, campaignId);
      await this.log(
        tx,
        campaignId,
        'TARGET_STATUS_CHANGED',
        'Статус контакта кампании изменён',
        { targetId },
        targetId,
        target.status,
        data.status,
      );
      return updated;
    });
  }

  async removeTarget(campaignId: string, targetId: string) {
    const campaign = await this.getCampaign(campaignId);
    this.assertEditable(campaign.status);
    await this.findTarget(campaignId, targetId);
    return this.prisma.$transaction(async (tx) => {
      const removed = await tx.campaignTarget.delete({
        where: { id: targetId },
      });
      await this.recalculateCounters(tx, campaignId);
      await this.log(
        tx,
        campaignId,
        'TARGET_REMOVED',
        'Контакт удалён из кампании',
        {
          targetId,
          contactId: removed.contactId,
        },
      );
      return removed;
    });
  }

  async findLogs(id: string, query: CampaignLogsQueryDto) {
    await this.getCampaign(id);
    const where = { campaignId: id };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.campaignLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.campaignLog.count({ where }),
    ]);
    return this.paginated(data, total, query.page, query.limit);
  }

  private async transition(
    id: string,
    allowed: CampaignStatus[],
    next: CampaignStatus,
    event: string,
    message: string,
  ) {
    const campaign = await this.getCampaign(id);
    if (!allowed.includes(campaign.status)) {
      throw new ConflictException(
        `Переход из статуса ${campaign.status} в ${next} запрещён`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.campaign.update({
        where: { id },
        data: {
          status: next,
          ...(next === CampaignStatus.RUNNING && !campaign.startedAt
            ? { startedAt: new Date() }
            : {}),
          ...(FINISHED_STATUSES.includes(next)
            ? { finishedAt: new Date() }
            : {}),
        },
        include: { settings: true },
      });
      await this.log(
        tx,
        id,
        event,
        message,
        undefined,
        undefined,
        campaign.status,
        next,
      );
      return updated;
    });
  }

  private async recalculateCounters(
    tx: Prisma.TransactionClient,
    campaignId: string,
  ) {
    const grouped = await tx.campaignTarget.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { _all: true },
    });
    const count = (statuses: Set<CampaignTargetStatus>) =>
      grouped.reduce(
        (sum, item) => sum + (statuses.has(item.status) ? item._count._all : 0),
        0,
      );
    const exact = (status: CampaignTargetStatus) =>
      grouped.find((item) => item.status === status)?._count._all ?? 0;
    await tx.campaign.update({
      where: { id: campaignId },
      data: {
        selectedCount: grouped.reduce((sum, item) => sum + item._count._all, 0),
        processedCount: count(PROCESSED_TARGET_STATUSES),
        repliedCount: count(REPLIED_TARGET_STATUSES),
        leadCount: exact(CampaignTargetStatus.LEAD),
        rejectedCount: exact(CampaignTargetStatus.REJECTED),
        handoffCount: exact(CampaignTargetStatus.HANDOFF),
      },
    });
  }

  private validateSettings(settings: {
    workingHoursStart: string;
    workingHoursEnd: string;
    minDelaySeconds: number;
    maxDelaySeconds: number;
  }) {
    if (settings.workingHoursStart >= settings.workingHoursEnd) {
      throw new BadRequestException(
        'Начало рабочего времени должно быть раньше окончания',
      );
    }
    if (settings.minDelaySeconds > settings.maxDelaySeconds) {
      throw new BadRequestException(
        'Минимальная пауза не может быть больше максимальной',
      );
    }
  }

  private assertEditable(status: CampaignStatus) {
    if (!EDITABLE_STATUSES.includes(status)) {
      throw new ConflictException(
        'Изменять состав можно только до запуска кампании',
      );
    }
  }

  private async getCampaign(id: string) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException('Кампания не найдена');
    return campaign;
  }

  private log(
    tx: Prisma.TransactionClient,
    campaignId: string,
    event: string,
    message: string,
    metadata?: Prisma.InputJsonObject,
    targetId?: string,
    previousStatus?: string,
    newStatus?: string,
  ) {
    return tx.campaignLog.create({
      data: {
        campaignId,
        targetId,
        event,
        message,
        previousStatus,
        newStatus,
        metadata,
      },
    });
  }

  private paginated<T>(data: T[], total: number, page: number, limit: number) {
    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
