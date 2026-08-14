/* eslint-disable @typescript-eslint/no-unsafe-assignment */
const statuses = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
} as const;
const types = {
  HANDOFF_REQUIRED: 'HANDOFF_REQUIRED',
  QUALIFIED_LEAD: 'QUALIFIED_LEAD',
  NEW_LEAD: 'NEW_LEAD',
  CLIENT_REQUESTED_MANAGER: 'CLIENT_REQUESTED_MANAGER',
  AI_UNCERTAIN: 'AI_UNCERTAIN',
  AI_FAILED: 'AI_FAILED',
  WHATSAPP_FAILED: 'WHATSAPP_FAILED',
  MEDIA_FAILED: 'MEDIA_FAILED',
  AUTOMATION_FAILED: 'AUTOMATION_FAILED',
  SYSTEM_ERROR: 'SYSTEM_ERROR',
} as const;

jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));
jest.mock('../generated/prisma/enums', () => ({
  TelegramNotificationStatus: statuses,
  TelegramNotificationType: types,
  TelegramRecipientStatus: { CONNECTED: 'CONNECTED' },
}));

import { TelegramNotificationsService } from './telegram-notifications.service';

describe('TelegramNotificationsService', () => {
  const recipient = { id: 'recipient-1', telegramChatId: 123n };
  const settings = {
    get: jest.fn().mockResolvedValue({
      enabled: true,
      notifyOnHandoff: true,
      notifyOnQualifiedLead: true,
    }),
  };
  const bot = { sendMessage: jest.fn() };
  const prisma = {
    contact: { findUnique: jest.fn() },
    lead: { findUnique: jest.fn() },
    message: { findFirst: jest.fn() },
    telegramRecipient: { findMany: jest.fn(), update: jest.fn() },
    telegramNotification: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const service = new TelegramNotificationsService(
    prisma as never,
    { enabled: true } as never,
    settings as never,
    bot as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.contact.findUnique.mockResolvedValue({
      companyName: 'Salon',
      phone: '+7700',
      city: 'Алматы',
      category: 'Салон красоты',
    });
    prisma.lead.findUnique.mockResolvedValue({
      qualificationReason: 'Запросил демонстрацию',
    });
    prisma.message.findFirst.mockResolvedValue({ text: 'Покажите демо' });
    prisma.telegramRecipient.findMany.mockResolvedValue([recipient]);
    prisma.telegramNotification.findUnique.mockResolvedValue(null);
    prisma.telegramNotification.create.mockResolvedValue({
      id: 'notification-1',
    });
    prisma.telegramNotification.update.mockImplementation(
      ({ data }: { data: unknown }) =>
        Promise.resolve({ id: 'notification-1', ...(data as object) }),
    );
    prisma.telegramRecipient.update.mockResolvedValue({});
    bot.sendMessage.mockResolvedValue({ message_id: 10, attempts: 1 });
  });

  it('creates exactly one QUALIFIED notification and deduplicates a repeated trigger', async () => {
    const input = {
      runId: 'run-1',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      leadId: 'lead-1',
      leadDecision: 'QUALIFIED',
    };
    await service.notifyLeadOutcome(input);
    prisma.telegramNotification.findUnique.mockResolvedValue({
      id: 'notification-1',
      status: 'SENT',
    });
    await service.notifyLeadOutcome(input);
    expect(prisma.telegramNotification.create).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(prisma.telegramNotification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: types.QUALIFIED_LEAD }),
      }),
    );
  });

  it('does not send WhatsApp transport failures to manager recipients', async () => {
    await expect(
      service.notifyWhatsAppFailed({
        deduplicationKey: 'message-1:WHATSAPP_FAILED',
        text: 'transport failed',
        contactId: 'contact-1',
        conversationId: 'conversation-1',
      }),
    ).resolves.toEqual({
      skipped: true,
      reason: 'TECHNICAL_ALERT_NOT_SENT_TO_MANAGER',
    });
    expect(prisma.telegramNotification.create).not.toHaveBeenCalled();
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('prioritizes one HANDOFF notification for a qualified handoff', async () => {
    await service.notifyLeadOutcome({
      runId: 'run-1',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      leadId: 'lead-1',
      action: 'HANDOFF',
      leadDecision: 'QUALIFIED',
    });
    expect(prisma.telegramNotification.create).toHaveBeenCalledTimes(1);
    expect(prisma.telegramNotification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: types.HANDOFF_REQUIRED }),
      }),
    );
  });

  it('contains Telegram timeout/network failure and records attempts', async () => {
    bot.sendMessage.mockRejectedValue(
      Object.assign(new Error('timeout'), { attempts: 3 }),
    );
    await expect(
      service.notifyLeadOutcome({
        runId: 'run-1',
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        leadId: 'lead-1',
        action: 'HANDOFF',
      }),
    ).resolves.toBeDefined();
    expect(prisma.telegramNotification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: statuses.FAILED, attempts: 3 }),
      }),
    );
  });

  it('returns an explicit diagnostic when recipient is disabled or absent', async () => {
    prisma.telegramRecipient.findMany.mockResolvedValue([]);
    await expect(
      service.notifyLeadOutcome({
        runId: 'run-1',
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        action: 'HANDOFF',
      }),
    ).resolves.toEqual({ skipped: true, reason: 'NO_ACTIVE_RECIPIENT' });
  });

  it('records SENT, sentAt and provider attempts after successful send', async () => {
    await service.notifyLeadOutcome({
      runId: 'run-1',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      leadId: 'lead-1',
      action: 'HANDOFF',
    });
    expect(prisma.telegramNotification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: statuses.SENT,
          attempts: 1,
          sentAt: expect.any(Date) as unknown,
        }),
      }),
    );
  });

  it('contains enrichment database failure without rejecting the business flow', async () => {
    prisma.contact.findUnique.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(
      service.notifyLeadOutcome({
        runId: 'run-1',
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        action: 'HANDOFF',
      }),
    ).resolves.toEqual({
      skipped: true,
      reason: 'LEAD_OUTCOME_ENRICHMENT_ERROR',
    });
  });
});
