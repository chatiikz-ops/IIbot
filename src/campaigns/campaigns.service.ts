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
  PromptStrategyStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignSelectionService } from './campaign-selection.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';
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
const TARGET_OUTCOME_PRIORITY = new Map<CampaignTargetStatus, number>([
  [CampaignTargetStatus.REJECTED, 1],
  [CampaignTargetStatus.HANDOFF, 2],
  [CampaignTargetStatus.LEAD, 3],
]);
const OPEN_TARGET_STATUSES = new Set<CampaignTargetStatus>([
  CampaignTargetStatus.WAITING,
  CampaignTargetStatus.READY,
  CampaignTargetStatus.QUEUED,
  CampaignTargetStatus.PROCESSING,
  CampaignTargetStatus.MESSAGE_SENT,
  CampaignTargetStatus.WAITING_REPLY,
]);

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly selection: CampaignSelectionService,
    private readonly whatsapp: WhatsAppClientService,
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
          for (let offset = 0; offset < contacts.length; offset += 1000) {
            await tx.campaignTarget.createMany({
              data: contacts.slice(offset, offset + 1000).map((contact) => ({
                campaignId: campaign.id,
                contactId: contact.id,
                status: CampaignTargetStatus.READY,
                strategyCode: contact.strategyCode,
                strategyAssignedAt: new Date(),
              })),
            });
          }
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
            for (let offset = 0; offset < contacts.length; offset += 1000) {
              await tx.campaignTarget.createMany({
                data: contacts.slice(offset, offset + 1000).map((contact) => ({
                  campaignId: id,
                  contactId: contact.id,
                  status: CampaignTargetStatus.READY,
                  strategyCode: contact.strategyCode,
                  strategyAssignedAt: new Date(),
                })),
              });
            }
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

  async start(id: string) {
    await this.refreshStrategySnapshots(id);
    const preflight = await this.preflight(id);
    if (!preflight.ready) {
      throw new ConflictException({
        message: 'Кампания не готова к запуску',
        issues: preflight.issues,
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.campaign.updateMany({
        where: {
          id,
          status: { in: [CampaignStatus.DRAFT, CampaignStatus.SCHEDULED] },
        },
        data: { status: CampaignStatus.RUNNING, startedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('Кампания уже запущена или изменена');
      }
      await this.log(
        tx,
        id,
        'CAMPAIGN_STARTED',
        'Кампания запущена',
        undefined,
        undefined,
        preflight.campaignStatus,
        CampaignStatus.RUNNING,
      );
      return tx.campaign.findUniqueOrThrow({
        where: { id },
        include: { settings: true },
      });
    });
  }

  async preflight(id: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      include: {
        settings: true,
        targets: {
          select: {
            strategyCode: true,
            contact: {
              select: {
                deletedAt: true,
                outreachEligible: true,
                strategyCode: true,
                classifiedAt: true,
              },
            },
          },
        },
      },
    });
    if (!campaign) throw new NotFoundException('Кампания не найдена');

    const [automation, whatsapp] = await Promise.all([
      this.prisma.automationSettings.findUnique({
        where: { singletonKey: 'global' },
      }),
      this.whatsapp.getStatus(),
    ]);
    const strategyCodes = [
      ...new Set(
        campaign.targets
          .map((target) => target.strategyCode)
          .filter((code): code is string => Boolean(code)),
      ),
    ];
    const strategies = await this.prisma.promptStrategy.findMany({
      where: { code: { in: strategyCodes } },
      select: { code: true, status: true, activeVersionId: true },
    });
    const byCode = new Map(
      strategies.map((strategy) => [strategy.code, strategy]),
    );
    const strategiesReady = strategyCodes.map((code) => {
      const strategy = byCode.get(code);
      return {
        code,
        status: strategy?.status ?? null,
        hasActiveVersion: Boolean(strategy?.activeVersionId),
        ready:
          strategy?.status === PromptStrategyStatus.ACTIVE &&
          Boolean(strategy.activeVersionId) &&
          code !== 'SKIP_EXISTING_CLIENT',
      };
    });
    const issues: Array<{ code: string; message: string }> = [];
    const issue = (code: string, message: string) =>
      issues.push({ code, message });
    if (!campaign.settings)
      issue('SETTINGS_MISSING', 'Настройки кампании отсутствуют');
    if (campaign.selectedCount <= 0 || campaign.targets.length === 0)
      issue('ZERO_TARGETS', 'В кампании нет получателей');
    if (!automation?.enabled)
      issue('AUTOMATION_DISABLED', 'Автоматизация отключена');
    if (!automation?.campaignSendingEnabled)
      issue('CAMPAIGN_SENDING_DISABLED', 'Отправка кампаний отключена');
    const whatsappConnected =
      whatsapp.connected && whatsapp.state === 'CONNECTED';
    if (!whatsappConnected)
      issue('WHATSAPP_NOT_CONNECTED', 'WhatsApp не подключён');
    if (campaign.targets.some((target) => target.contact.deletedAt))
      issue('CONTACT_DELETED', 'Кампания содержит удалённые контакты');
    if (campaign.targets.some((target) => !target.contact.outreachEligible))
      issue('CONTACT_NOT_ELIGIBLE', 'Кампания содержит исключённые контакты');
    const unclassifiedCount = campaign.targets.filter(
      (target) => !target.contact.classifiedAt,
    ).length;
    if (unclassifiedCount > 0)
      issue(
        'CLASSIFICATION_MISSING',
        `Для ${unclassifiedCount} контактов не завершена классификация`,
      );
    const missingStrategyCount = campaign.targets.filter(
      (target) => !target.strategyCode,
    ).length;
    if (missingStrategyCount > 0)
      issue(
        'STRATEGY_MISSING',
        `Для ${missingStrategyCount} контактов не назначена стратегия`,
      );
    if (strategyCodes.length === 0)
      issue('STRATEGY_MISSING', 'Для получателей не выбрана стратегия');
    for (const strategy of strategiesReady) {
      if (!strategy.ready)
        issue('STRATEGY_NOT_READY', `Стратегия ${strategy.code} не активна`);
    }
    if (campaign.settings) {
      if (campaign.settings.dailyMessageLimit <= 0)
        issue('DAILY_LIMIT_INVALID', 'Дневной лимит должен быть больше нуля');
      if (campaign.settings.minDelaySeconds > campaign.settings.maxDelaySeconds)
        issue(
          'DELAY_RANGE_INVALID',
          'Минимальная задержка больше максимальной',
        );
      try {
        new Intl.DateTimeFormat('en-US', {
          timeZone: campaign.settings.timezone,
        }).format();
      } catch {
        issue('TIMEZONE_INVALID', 'Некорректный timezone');
      }
    }
    return {
      ready: issues.length === 0,
      issues,
      targetCount: campaign.targets.length,
      strategyCodes,
      strategiesReady,
      whatsappConnected,
      automationEnabled: Boolean(automation?.enabled),
      campaignSendingEnabled: Boolean(automation?.campaignSendingEnabled),
      campaignStatus: campaign.status,
    };
  }

  private async refreshStrategySnapshots(id: string) {
    const campaign = await this.getCampaign(id);
    this.assertEditable(campaign.status);
    const refreshed = await this.prisma.$executeRaw`
      UPDATE "CampaignTarget" target
      SET "strategyCode" = contact."strategyCode", "strategyAssignedAt" = NOW(), "updatedAt" = NOW()
      FROM "Contact" contact
      WHERE target."campaignId" = ${id}
        AND target."contactId" = contact."id"
        AND target."strategyCode" IS DISTINCT FROM contact."strategyCode"
    `;
    if (refreshed > 0) {
      await this.prisma.campaignLog.create({
        data: {
          campaignId: id,
          event: 'CAMPAIGN_STRATEGY_SNAPSHOT_REFRESHED',
          message: 'Strategy snapshots refreshed before campaign start',
          metadata: { refreshed },
        },
      });
    }
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

  findTargetByConversationId(conversationId: string) {
    return this.prisma.campaignTarget.findUnique({
      where: { conversationId },
    });
  }

  async markTargetReplied(conversationId: string) {
    const target = await this.findTargetByConversationId(conversationId);
    if (!target || target.repliedAt) return target;
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.campaignTarget.findUnique({
        where: { id: target.id },
      });
      if (!current || current.repliedAt) return current;
      const status = TARGET_OUTCOME_PRIORITY.has(current.status)
        ? current.status
        : CampaignTargetStatus.REPLIED;
      const updated = await tx.campaignTarget.update({
        where: { id: current.id },
        data: {
          status,
          repliedAt: new Date(),
          completedAt: current.completedAt ?? new Date(),
          errorMessage:
            status === CampaignTargetStatus.REPLIED ? null : undefined,
        },
      });
      await this.recalculateCounters(tx, current.campaignId);
      return updated;
    });
  }

  attachConversation(targetId: string, conversationId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campaign-target-conversation:${targetId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campaign-conversation-owner:${conversationId}`}))`;
      const target = await tx.campaignTarget.findUnique({
        where: { id: targetId },
        include: { conversation: true },
      });
      if (!target) {
        throw new NotFoundException('Контакт кампании не найден');
      }
      if (target.conversation) return target.conversation;

      const proposed = await tx.conversation.findUnique({
        where: { id: conversationId },
      });
      if (!proposed || proposed.contactId !== target.contactId) {
        throw new ConflictException(
          'Conversation не принадлежит контакту CampaignTarget',
        );
      }
      const existingOwner = await tx.campaignTarget.findUnique({
        where: { conversationId },
        select: { id: true },
      });
      const conversation = existingOwner
        ? await tx.conversation.create({
            data: {
              contactId: target.contactId,
              strategyCode: target.strategyCode ?? proposed.strategyCode,
              metadata: { source: 'CAMPAIGN_TARGET' },
            },
          })
        : proposed;

      await tx.campaignTarget.update({
        where: { id: targetId },
        data: { conversationId: conversation.id },
      });
      return conversation;
    });
  }

  createConversationForTarget(targetId: string, strategyCode: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campaign-target-conversation:${targetId}`}))`;
      const target = await tx.campaignTarget.findUnique({
        where: { id: targetId },
        include: { conversation: true },
      });
      if (!target) {
        throw new NotFoundException('Контакт кампании не найден');
      }
      if (target.conversation) return target.conversation;

      const conversation = await tx.conversation.create({
        data: {
          contactId: target.contactId,
          strategyCode,
          metadata: { source: 'CAMPAIGN_TARGET', targetId },
        },
      });
      await tx.campaignTarget.update({
        where: { id: targetId },
        data: { conversationId: conversation.id },
      });
      return conversation;
    });
  }

  async addTarget(campaignId: string, data: CreateCampaignTargetDto) {
    const campaign = await this.getCampaign(campaignId);
    this.assertEditable(campaign.status);
    const contact = await this.prisma.contact.findFirst({
      where: { id: data.contactId, deletedAt: null },
    });
    if (!contact) throw new NotFoundException('Контакт не найден');
    if (
      !contact.outreachEligible ||
      contact.strategyCode === 'SKIP_EXISTING_CLIENT'
    ) {
      throw new ConflictException('Контакт исключён из исходящих кампаний');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const target = await tx.campaignTarget.create({
          data: {
            campaignId,
            contactId: data.contactId,
            strategyCode: data.strategyCode ?? contact.strategyCode,
            strategyAssignedAt: new Date(),
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
    const currentPriority = TARGET_OUTCOME_PRIORITY.get(target.status) ?? 0;
    const requestedPriority = TARGET_OUTCOME_PRIORITY.get(data.status) ?? 0;
    const nextStatus =
      currentPriority > 0 && requestedPriority < currentPriority
        ? target.status
        : data.status;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.campaignTarget.update({
        where: { id: targetId },
        data: {
          status: nextStatus,
          errorMessage:
            nextStatus === CampaignTargetStatus.ERROR
              ? data.errorMessage
              : null,
          ...(nextStatus === CampaignTargetStatus.QUEUED
            ? { queuedAt: now }
            : {}),
          ...(nextStatus === CampaignTargetStatus.PROCESSING
            ? { processingStartedAt: now }
            : {}),
          ...(nextStatus === CampaignTargetStatus.MESSAGE_SENT ||
          nextStatus === CampaignTargetStatus.WAITING_REPLY
            ? { messageSentAt: now }
            : {}),
          ...(REPLIED_TARGET_STATUSES.has(nextStatus)
            ? { repliedAt: now }
            : {}),
          ...(PROCESSED_TARGET_STATUSES.has(nextStatus)
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
        nextStatus,
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
    const repliedCount = await tx.campaignTarget.count({
      where: { campaignId, repliedAt: { not: null } },
    });
    await tx.campaign.update({
      where: { id: campaignId },
      data: {
        selectedCount: grouped.reduce((sum, item) => sum + item._count._all, 0),
        processedCount: count(PROCESSED_TARGET_STATUSES),
        repliedCount,
        leadCount: exact(CampaignTargetStatus.LEAD),
        rejectedCount: exact(CampaignTargetStatus.REJECTED),
        handoffCount: exact(CampaignTargetStatus.HANDOFF),
        failedCount: exact(CampaignTargetStatus.ERROR),
      },
    });
    if (count(OPEN_TARGET_STATUSES) === 0) {
      await tx.campaign.updateMany({
        where: { id: campaignId, status: CampaignStatus.RUNNING },
        data: { status: CampaignStatus.COMPLETED, finishedAt: new Date() },
      });
    }
  }

  private validateSettings(settings: {
    workingHoursStart: string;
    workingHoursEnd: string;
    timezone: string;
    minDelaySeconds: number;
    maxDelaySeconds: number;
  }) {
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.workingHoursStart) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.workingHoursEnd)
    ) {
      throw new BadRequestException(
        'Начало рабочего времени должно быть раньше окончания',
      );
    }
    if (settings.minDelaySeconds > settings.maxDelaySeconds) {
      throw new BadRequestException(
        'Минимальная пауза не может быть больше максимальной',
      );
    }
    try {
      new Intl.DateTimeFormat('en-US', {
        timeZone: settings.timezone,
      }).format();
    } catch {
      throw new BadRequestException('Некорректный timezone');
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
