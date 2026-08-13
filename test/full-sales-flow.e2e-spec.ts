/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { AppModule } from '../src/app.module';
import { AutomationWorkerService } from '../src/automation/automation-worker.service';
import { ConversationOrchestratorService } from '../src/automation/conversation-orchestrator.service';
import {
  BusinessType,
  CampaignSourceType,
  CampaignStatus,
  CampaignTargetStatus,
  ConversationStatus,
  CrmProvider,
  MessageRole,
  PromptStrategyStatus,
  TelegramNotificationStatus,
  TelegramNotificationType,
  WhatsAppMessageDirection,
  WhatsAppMessageStatus,
} from '../src/generated/prisma/enums';
import { ImportsService } from '../src/imports/imports.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelegramNotificationsService } from '../src/telegram/telegram-notifications.service';
import { WhatsAppClientService } from '../src/whatsapp/whatsapp-client.service';

type WorkerInternals = {
  runCampaignTarget(targetId: string): Promise<Date | null>;
};

describe('Full sales flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let imports: ImportsService;
  let worker: WorkerInternals;
  let orchestrator: ConversationOrchestratorService;
  const marker = `full-flow-${Date.now()}`;
  const phone = `+7703${String(Date.now()).slice(-7)}`;
  let importId = '';
  let contactId = '';
  let campaignId = '';
  let strategyId = '';
  let telegramCalls = 0;
  let initialAutomation: {
    enabled: boolean;
    autoReplyEnabled: boolean;
    campaignSendingEnabled: boolean;
    responseDelayMinSeconds: number;
    responseDelayMaxSeconds: number;
  } | null = null;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.OPENAI_MOCK_MODE = 'true';
    process.env.WHATSAPP_ENABLED = 'false';
    process.env.TELEGRAM_ENABLED = 'false';
    process.env.AUTOMATION_WORKER_ENABLED = 'false';
    const whatsappClientMock = {
      onMessage: () => undefined,
      onAck: () => undefined,
      isRegisteredUser: () => Promise.resolve(true),
      sendText: () =>
        Promise.resolve({
          id: { _serialized: `${marker}:${Date.now()}` },
        }),
      getStatus: () =>
        Promise.resolve({ connected: true, status: 'CONNECTED' }),
    };
    const moduleBuilder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WhatsAppClientService)
      .useValue(whatsappClientMock)
      .overrideProvider(TelegramNotificationsService)
      .useFactory({
        inject: [PrismaService],
        factory: (database: PrismaService) => {
          const notify = async (input: {
            deduplicationKey: string;
            contactId?: string;
            conversationId?: string;
            leadId?: string;
          }) => {
            telegramCalls += 1;
            return database.telegramNotification.upsert({
              where: {
                deduplicationKey: `${marker}:${input.deduplicationKey}`,
              },
              create: {
                type: TelegramNotificationType.QUALIFIED_LEAD,
                status: TelegramNotificationStatus.SENT,
                deduplicationKey: `${marker}:${input.deduplicationKey}`,
                contactId: input.contactId,
                conversationId: input.conversationId,
                leadId: input.leadId,
                providerMessageId: `mock-${telegramCalls}`,
                sentAt: new Date(),
              },
              update: {},
            });
          };
          return {
            notifyHandoff: notify,
            notifyNewLead: notify,
            notifyQualifiedLead: notify,
            notifyAiUncertain: notify,
            notifyAiFailed: notify,
            notifyWhatsAppFailed: notify,
          };
        },
      });
    const module = await moduleBuilder.compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    imports = app.get(ImportsService);
    orchestrator = app.get(ConversationOrchestratorService);
    worker = app.get(AutomationWorkerService) as unknown as WorkerInternals;
    initialAutomation = await prisma.automationSettings.findUnique({
      where: { singletonKey: 'global' },
      select: {
        enabled: true,
        autoReplyEnabled: true,
        campaignSendingEnabled: true,
        responseDelayMinSeconds: true,
        responseDelayMaxSeconds: true,
      },
    });
    await prisma.automationSettings.upsert({
      where: { singletonKey: 'global' },
      create: {
        singletonKey: 'global',
        enabled: true,
        autoReplyEnabled: true,
        campaignSendingEnabled: true,
        responseDelayMinSeconds: 0,
        responseDelayMaxSeconds: 0,
      },
      update: {
        enabled: true,
        autoReplyEnabled: true,
        campaignSendingEnabled: true,
        responseDelayMinSeconds: 0,
        responseDelayMaxSeconds: 0,
      },
    });
  });

  afterAll(async () => {
    if (campaignId)
      await prisma.campaign.deleteMany({ where: { id: campaignId } });
    if (contactId)
      await prisma.contact.deleteMany({ where: { id: contactId } });
    if (importId)
      await prisma.importJob.deleteMany({ where: { id: importId } });
    if (strategyId)
      await prisma.promptStrategy.deleteMany({ where: { id: strategyId } });
    await prisma.telegramNotification.deleteMany({
      where: { deduplicationKey: { startsWith: marker } },
    });
    if (initialAutomation) {
      await prisma.automationSettings.update({
        where: { singletonKey: 'global' },
        data: initialAutomation,
      });
    }
    await app.close();
  });

  it('runs Import -> Classification -> Campaign -> AI -> WhatsApp -> Lead -> Telegram', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['Company Name', 'Phone', 'Category', 'Booking URL', 'City'],
        [
          `${marker} Beauty Salon`,
          phone,
          'beauty salon',
          'https://demo.altegio.com/book',
          'Almaty',
        ],
      ]),
      'Contacts',
    );
    const buffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
    const preview = await imports.preview({
      fieldname: 'file',
      originalname: `${marker}.xlsx`,
      encoding: '7bit',
      mimetype:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: buffer.length,
      buffer,
    } as Express.Multer.File);
    importId = preview.importId;
    await imports.confirm(importId);
    const contact = await prisma.contact.findFirstOrThrow({
      where: { phone, deletedAt: null },
    });
    contactId = contact.id;
    expect(contact.crmProvider).toBe(CrmProvider.ALTEGIO);
    expect(contact.businessType).toBe(BusinessType.BEAUTY_SALON);
    expect(contact.strategyCode).toBe('BEAUTY_COMPETITOR');

    const strategy = await prisma.promptStrategy.create({
      data: {
        code: `BEAUTY_COMPETITOR_${marker}`,
        name: marker,
        status: PromptStrategyStatus.ACTIVE,
      },
    });
    strategyId = strategy.id;
    const version = await prisma.promptVersion.create({
      data: {
        strategyId: strategy.id,
        version: 1,
        systemInstruction: 'Sell safely.',
        objective: 'Qualify.',
        firstMessage: 'Hello {{companyName}}',
        communicationRules: 'Be concise.',
        qualificationQuestions: [],
        sellingPoints: [],
        handoffRules: 'Handoff on request.',
        stopRules: 'Stop on refusal.',
        forbiddenActions: [],
        closingRules: 'Close politely.',
        maxAssistantMessages: 5,
      },
    });
    await prisma.promptStrategy.update({
      where: { id: strategy.id },
      data: { activeVersionId: version.id },
    });
    await prisma.contact.update({
      where: { id: contact.id },
      data: { strategyCode: strategy.code },
    });

    const campaign = await prisma.campaign.create({
      data: {
        name: marker,
        status: CampaignStatus.RUNNING,
        sourceType: CampaignSourceType.IMPORT_JOB,
        sourceImportJobId: importId,
        filters: {},
        settings: {
          create: {
            workingHoursStart: '00:00',
            workingHoursEnd: '00:00',
            dailyMessageLimit: 10,
            minDelaySeconds: 0,
            maxDelaySeconds: 0,
            timezone: 'Asia/Almaty',
          },
        },
        targets: {
          create: {
            contactId: contact.id,
            strategyCode: strategy.code,
            status: CampaignTargetStatus.QUEUED,
          },
        },
      },
      include: { targets: true },
    });
    campaignId = campaign.id;
    const target = campaign.targets[0];
    await worker.runCampaignTarget(target.id);
    const sentTarget = await prisma.campaignTarget.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(sentTarget.status).toBe(CampaignTargetStatus.WAITING_REPLY);
    expect(sentTarget.messageSentAt).not.toBeNull();
    const conversationId = sentTarget.conversationId!;
    expect(
      await prisma.message.count({
        where: { conversationId, role: MessageRole.AI },
      }),
    ).toBe(1);
    expect(await prisma.aiRun.count({ where: { conversationId } })).toBe(1);
    expect(
      await prisma.whatsAppMessage.count({
        where: {
          conversationId,
          direction: WhatsAppMessageDirection.OUTBOUND,
          status: WhatsAppMessageStatus.SENT,
        },
      }),
    ).toBe(1);

    const inbound = await prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId,
          role: MessageRole.CLIENT,
          text: 'Yes, I want a demo.',
        },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          status: ConversationStatus.ACTIVE,
          messageCount: { increment: 1 },
          lastMessageAt: message.createdAt,
        },
      });
      const whatsapp = await tx.whatsAppMessage.create({
        data: {
          externalMessageId: `${marker}:inbound`,
          direction: WhatsAppMessageDirection.INBOUND,
          status: WhatsAppMessageStatus.RECEIVED,
          phone,
          text: message.text,
          contactId,
          conversationId,
          messageId: message.id,
          receivedAt: new Date(),
        },
      });
      return { message, whatsapp };
    });
    await orchestrator.processIncomingClientMessage(
      {
        contactId,
        conversationId,
        messageId: inbound.message.id,
        whatsAppMessageId: inbound.whatsapp.id,
      },
      'QUALIFIED',
    );
    const lead = await prisma.lead.findUniqueOrThrow({
      where: { conversationId },
    });
    expect(
      (
        await prisma.conversation.findUniqueOrThrow({
          where: { id: conversationId },
        })
      ).status,
    ).toBe(ConversationStatus.QUALIFIED);
    expect(await prisma.aiRun.count({ where: { conversationId } })).toBe(2);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        await prisma.telegramNotification.count({ where: { leadId: lead.id } })
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      await prisma.telegramNotification.count({ where: { leadId: lead.id } }),
    ).toBeGreaterThanOrEqual(1);
    const finalTarget = await prisma.campaignTarget.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect([CampaignTargetStatus.LEAD, CampaignTargetStatus.REPLIED]).toContain(
      finalTarget.status,
    );
    const finalCampaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaign.id },
    });
    expect(finalCampaign.processedCount).toBe(1);
    expect(finalCampaign.leadCount).toBe(1);
  });
});
