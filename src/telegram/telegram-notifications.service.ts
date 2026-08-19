import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  TelegramNotificationStatus,
  TelegramNotificationType,
  TelegramRecipientStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { TelegramNotificationsQueryDto } from './dto/telegram.dto';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramConfigService } from './telegram-config.service';
import { TelegramSettingsService } from './telegram-settings.service';

type NotificationInput = {
  type: TelegramNotificationType;
  deduplicationKey: string;
  text: string;
  contactId?: string;
  conversationId?: string;
  leadId?: string;
  automationEventId?: string;
  url?: { label: string; value: string };
};

@Injectable()
export class TelegramNotificationsService {
  private readonly logger = new Logger(TelegramNotificationsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TelegramConfigService,
    private readonly settings: TelegramSettingsService,
    private readonly bot: TelegramBotService,
  ) {}

  notifyHandoff(data: Omit<NotificationInput, 'type'>) {
    return this.notify({
      ...data,
      type: TelegramNotificationType.HANDOFF_REQUIRED,
    });
  }
  notifyNewLead(data: Omit<NotificationInput, 'type'>) {
    return this.notify({ ...data, type: TelegramNotificationType.NEW_LEAD });
  }
  notifyQualifiedLead(data: Omit<NotificationInput, 'type'>) {
    return this.notify({
      ...data,
      type: TelegramNotificationType.QUALIFIED_LEAD,
    });
  }
  notifyAiUncertain(data: Omit<NotificationInput, 'type'>) {
    return this.notify({
      ...data,
      type: TelegramNotificationType.AI_UNCERTAIN,
    });
  }
  notifyAiFailed(data: Omit<NotificationInput, 'type'>) {
    return this.notify({ ...data, type: TelegramNotificationType.AI_FAILED });
  }
  notifyWhatsAppFailed(data: Omit<NotificationInput, 'type'>) {
    this.logger.warn({
      event: 'WHATSAPP_TECHNICAL_ALERT_LOGGED',
      deduplicationKey: data.deduplicationKey,
      contactId: data.contactId,
      conversationId: data.conversationId,
    });
    return Promise.resolve({
      skipped: true,
      reason: 'TECHNICAL_ALERT_NOT_SENT_TO_MANAGER',
    });
  }
  notifyMediaFailed(data: Omit<NotificationInput, 'type'>) {
    return this.notify({
      ...data,
      type: TelegramNotificationType.MEDIA_FAILED,
    });
  }
  notifyAutomationFailed(data: Omit<NotificationInput, 'type'>) {
    return this.notify({
      ...data,
      type: TelegramNotificationType.AUTOMATION_FAILED,
    });
  }

  async notifyLeadOutcome(data: {
    runId: string;
    contactId: string;
    conversationId: string;
    leadId?: string;
    action?: string;
    leadDecision?: string;
  }) {
    try {
      return await this.notifyLeadOutcomeSafely(data);
    } catch (error) {
      this.logger.error({
        event: 'TELEGRAM_LEAD_OUTCOME_FAILED',
        runId: data.runId,
        leadId: data.leadId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return { skipped: true, reason: 'LEAD_OUTCOME_ENRICHMENT_ERROR' };
    }
  }

  private async notifyLeadOutcomeSafely(data: {
    runId: string;
    contactId: string;
    conversationId: string;
    leadId?: string;
    action?: string;
    leadDecision?: string;
  }) {
    if (data.action !== 'HANDOFF' && data.leadDecision !== 'QUALIFIED') {
      return { skipped: true, reason: 'OUTCOME_NOT_NOTIFIABLE' };
    }
    const [contact, lead, lastClientMessage] = await Promise.all([
      this.prisma.contact.findUnique({ where: { id: data.contactId } }),
      data.leadId
        ? this.prisma.lead.findUnique({ where: { id: data.leadId } })
        : null,
      this.prisma.message.findFirst({
        where: { conversationId: data.conversationId, role: 'CLIENT' },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const handoff = data.action === 'HANDOFF';
    const type = handoff
      ? TelegramNotificationType.HANDOFF_REQUIRED
      : TelegramNotificationType.QUALIFIED_LEAD;
    const keyOwner = data.leadId ?? data.runId;
    const text = [
      handoff
        ? 'Новый заинтересованный клиент'
        : 'Новый квалифицированный клиент',
      '',
      `Компания: ${contact?.companyName ?? 'не указана'}`,
      `Телефон: ${contact?.phone ?? 'не указан'}`,
      `Город: ${contact?.city ?? 'не указан'}`,
      `Тип: ${contact?.category ?? contact?.businessType ?? 'не указан'}`,
      '',
      `Причина передачи: ${lead?.qualificationReason ?? (handoff ? 'Клиент запросил менеджера' : 'Клиент квалифицирован')}`,
      `Последнее сообщение: ${lastClientMessage?.text.slice(0, 500) ?? 'не найдено'}`,
      '',
      'Статус: Нужен менеджер',
    ].join('\n');
    return this.notify({
      type,
      deduplicationKey: `${keyOwner}:LEAD_OUTCOME`,
      text,
      contactId: data.contactId,
      conversationId: data.conversationId,
      leadId: data.leadId,
    });
  }

  async notify(input: NotificationInput) {
    try {
      return await this.notifySafely(input);
    } catch (error) {
      this.logger.error({
        event: 'TELEGRAM_NOTIFICATION_FLOW_FAILED',
        type: input.type,
        deduplicationKey: input.deduplicationKey,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return { skipped: true, reason: 'NOTIFICATION_FLOW_ERROR' };
    }
  }

  private async notifySafely(input: NotificationInput) {
    const settings = await this.settings.get();
    const enabled =
      this.config.enabled &&
      settings.enabled &&
      this.switchEnabled(settings, input.type);
    if (!enabled) return { skipped: true, reason: 'NOTIFICATION_DISABLED' };
    const recipients = await this.prisma.telegramRecipient.findMany({
      where: {
        status: TelegramRecipientStatus.CONNECTED,
        isActive: true,
        telegramChatId: { not: null },
      },
    });
    if (!recipients.length) {
      this.logger.warn({
        event: 'TELEGRAM_NOTIFICATION_SKIPPED',
        type: input.type,
        reason: 'NO_ACTIVE_RECIPIENT',
      });
      return { skipped: true, reason: 'NO_ACTIVE_RECIPIENT' };
    }
    return Promise.all(
      recipients.map(async (recipient) => {
        const key = `${input.deduplicationKey}:${recipient.id}`;
        const existing = await this.prisma.telegramNotification.findUnique({
          where: { deduplicationKey: key },
        });
        if (existing) return existing;
        let notification: { id: string };
        try {
          notification = await this.prisma.telegramNotification.create({
            data: {
              recipientId: recipient.id,
              type: input.type,
              status: TelegramNotificationStatus.PENDING,
              contactId: input.contactId,
              conversationId: input.conversationId,
              leadId: input.leadId,
              automationEventId: input.automationEventId,
              deduplicationKey: key,
              messagePreview: input.text.slice(0, 700),
            },
          });
          this.logger.log({
            event: 'TELEGRAM_NOTIFICATION_CREATED',
            notificationId: notification.id,
            type: input.type,
            contactId: input.contactId,
            conversationId: input.conversationId,
          });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            return this.prisma.telegramNotification.findUniqueOrThrow({
              where: { deduplicationKey: key },
            });
          }
          throw error;
        }
        try {
          this.logger.log({
            event: 'TELEGRAM_SEND_ATTEMPT',
            notificationId: notification.id,
            type: input.type,
          });
          const sent = await this.bot.sendMessage(
            recipient.telegramChatId!,
            input.text.slice(0, 4000),
            input.url,
          );
          await this.prisma.telegramRecipient.update({
            where: { id: recipient.id },
            data: { lastNotificationAt: new Date() },
          });
          this.logger.log({
            event: 'TELEGRAM_SEND_SUCCESS',
            notificationId: notification.id,
            type: input.type,
            attempts: sent.attempts,
            providerMessageId: String(sent.message_id),
          });
          return this.prisma.telegramNotification.update({
            where: { id: notification.id },
            data: {
              status: TelegramNotificationStatus.SENT,
              providerMessageId: String(sent.message_id),
              sentAt: new Date(),
              attempts: sent.attempts,
              lastAttemptAt: new Date(),
            },
          });
        } catch (error) {
          this.logger.error({
            event: 'TELEGRAM_SEND_FAILED',
            notificationId: notification.id,
            type: input.type,
            attempts: this.errorAttempts(error),
            errorCode:
              error instanceof Error
                ? error.message.slice(0, 100)
                : 'TELEGRAM_ERROR',
          });
          return this.prisma.telegramNotification.update({
            where: { id: notification.id },
            data: {
              status: TelegramNotificationStatus.FAILED,
              errorCode:
                error instanceof Error
                  ? error.message.slice(0, 100)
                  : 'TELEGRAM_ERROR',
              errorMessage: 'Telegram notification failed',
              attempts: this.errorAttempts(error),
              lastAttemptAt: new Date(),
            },
          });
        }
      }),
    );
  }

  async findAll(query: TelegramNotificationsQueryDto) {
    const where: Prisma.TelegramNotificationWhereInput = {
      type: query.type,
      status: query.status,
      recipientId: query.recipientId,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.telegramNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.telegramNotification.count({ where }),
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
    const item = await this.prisma.telegramNotification.findUnique({
      where: { id },
    });
    if (!item) throw new NotFoundException('Telegram notification не найдено');
    return item;
  }

  private switchEnabled(
    settings: Record<string, unknown>,
    type: TelegramNotificationType,
  ) {
    const map: Record<TelegramNotificationType, string> = {
      HANDOFF_REQUIRED: 'notifyOnHandoff',
      CLIENT_REQUESTED_MANAGER: 'notifyOnClientRequestedManager',
      NEW_LEAD: 'notifyOnNewLead',
      QUALIFIED_LEAD: 'notifyOnQualifiedLead',
      AI_UNCERTAIN: 'notifyOnAiUncertain',
      AI_FAILED: 'notifyOnAiFailure',
      WHATSAPP_FAILED: 'notifyOnWhatsAppFailure',
      MEDIA_FAILED: 'notifyOnMediaFailure',
      AUTOMATION_FAILED: 'notifyOnAutomationFailure',
      SYSTEM_ERROR: 'notifyOnSystemError',
    };
    return settings[map[type]] === true;
  }

  private errorAttempts(error: unknown) {
    if (!error || typeof error !== 'object' || !('attempts' in error)) return 1;
    const attempts = Number(error.attempts);
    return Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
  }
}
