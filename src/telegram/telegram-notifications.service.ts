import { Injectable, NotFoundException } from '@nestjs/common';
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
    return this.notify({
      ...data,
      type: TelegramNotificationType.WHATSAPP_FAILED,
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

  async notify(input: NotificationInput) {
    const settings = await this.settings.get();
    const enabled =
      this.config.enabled &&
      settings.enabled &&
      this.switchEnabled(settings, input.type);
    if (!enabled) return { skipped: true };
    const recipients = await this.prisma.telegramRecipient.findMany({
      where: {
        status: TelegramRecipientStatus.CONNECTED,
        isActive: true,
        telegramChatId: { not: null },
      },
    });
    if (!recipients.length) return { skipped: true };
    return Promise.all(
      recipients.map(async (recipient) => {
        const key = `${input.deduplicationKey}:${recipient.id}`;
        const existing = await this.prisma.telegramNotification.findUnique({
          where: { deduplicationKey: key },
        });
        if (existing) return existing;
        const notification = await this.prisma.telegramNotification.create({
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
        try {
          const sent = await this.bot.sendMessage(
            recipient.telegramChatId!,
            input.text.slice(0, 4000),
            input.url,
          );
          await this.prisma.telegramRecipient.update({
            where: { id: recipient.id },
            data: { lastNotificationAt: new Date() },
          });
          return this.prisma.telegramNotification.update({
            where: { id: notification.id },
            data: {
              status: TelegramNotificationStatus.SENT,
              providerMessageId: String(sent.message_id),
              sentAt: new Date(),
            },
          });
        } catch (error) {
          return this.prisma.telegramNotification.update({
            where: { id: notification.id },
            data: {
              status: TelegramNotificationStatus.FAILED,
              errorCode:
                error instanceof Error
                  ? error.message.slice(0, 100)
                  : 'TELEGRAM_ERROR',
              errorMessage: 'Telegram notification failed',
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
}
