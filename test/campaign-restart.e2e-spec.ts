/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { AutomationWorkerService } from '../src/automation/automation-worker.service';
import { ConversationOrchestratorService } from '../src/automation/conversation-orchestrator.service';
import {
  AutomationJobStatus,
  AutomationJobType,
  CampaignSourceType,
  CampaignStatus,
  CampaignTargetStatus,
  PromptStrategyStatus,
  WhatsAppMessageDirection,
} from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelegramNotificationsService } from '../src/telegram/telegram-notifications.service';
import { WhatsAppClientService } from '../src/whatsapp/whatsapp-client.service';

type Job = {
  id: string;
  type: AutomationJobType;
  attempts: number;
  maxAttempts: number;
  campaignTargetId: string | null;
  payload: null;
};
type WorkerInternals = {
  claim(): Promise<Job | null>;
  execute(job: Job): Promise<void>;
  enqueueCampaignTargets(): Promise<void>;
};

describe('Campaign restart and outbound idempotency (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let workerA: WorkerInternals;
  let workerB: WorkerInternals;
  const marker = `restart-e2e-${Date.now()}`;
  let campaignId = '';
  let strategyId = '';
  const contactIds: string[] = [];
  let transportCalls = 0;
  let initialAutomation: {
    enabled: boolean;
    campaignSendingEnabled: boolean;
  } | null = null;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.OPENAI_MOCK_MODE = 'true';
    process.env.AUTOMATION_WORKER_ENABLED = 'false';
    process.env.AUTOMATION_JOB_STALE_LOCK_SECONDS = '30';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WhatsAppClientService)
      .useValue({
        onMessage: () => undefined,
        onAck: () => undefined,
        isRegisteredUser: () => Promise.resolve(true),
        sendText: () => {
          transportCalls += 1;
          return Promise.resolve({
            id: { _serialized: `${marker}:out:${transportCalls}` },
          });
        },
        getStatus: () =>
          Promise.resolve({ connected: true, state: 'CONNECTED' }),
      })
      .overrideProvider(TelegramNotificationsService)
      .useValue({
        notifyLeadOutcome: () => Promise.resolve({ skipped: true }),
        notifyHandoff: () => Promise.resolve({ skipped: true }),
        notifyNewLead: () => Promise.resolve({ skipped: true }),
        notifyQualifiedLead: () => Promise.resolve({ skipped: true }),
        notifyAiUncertain: () => Promise.resolve({ skipped: true }),
        notifyAiFailed: () => Promise.resolve({ skipped: true }),
        notifyWhatsAppFailed: () => Promise.resolve({ skipped: true }),
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    workerA = app.get(AutomationWorkerService) as unknown as WorkerInternals;
    workerB = new AutomationWorkerService(
      prisma,
      app.get(ConversationOrchestratorService),
    ) as unknown as WorkerInternals;
    initialAutomation = await prisma.automationSettings.findUnique({
      where: { singletonKey: 'global' },
      select: { enabled: true, campaignSendingEnabled: true },
    });
    await prisma.automationSettings.upsert({
      where: { singletonKey: 'global' },
      create: {
        singletonKey: 'global',
        enabled: true,
        campaignSendingEnabled: true,
      },
      update: { enabled: true, campaignSendingEnabled: true },
    });
  });

  afterAll(async () => {
    if (campaignId)
      await prisma.campaign.deleteMany({ where: { id: campaignId } });
    await prisma.automationJob.deleteMany({
      where: { deduplicationKey: { startsWith: marker } },
    });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    if (strategyId)
      await prisma.promptStrategy.deleteMany({ where: { id: strategyId } });
    await app.close();
  });

  it('recovers stale work and never duplicates completed outbound lifecycle', async () => {
    const strategy = await prisma.promptStrategy.create({
      data: { code: marker, name: marker, status: PromptStrategyStatus.ACTIVE },
    });
    strategyId = strategy.id;
    const version = await prisma.promptVersion.create({
      data: {
        strategyId,
        version: 1,
        systemInstruction: 'Test.',
        objective: 'Test.',
        firstMessage: 'Hello.',
        communicationRules: 'Test.',
        qualificationQuestions: [],
        sellingPoints: [],
        handoffRules: 'Test.',
        stopRules: 'Test.',
        forbiddenActions: [],
        closingRules: 'Test.',
      },
    });
    await prisma.promptStrategy.update({
      where: { id: strategyId },
      data: { activeVersionId: version.id },
    });
    for (let index = 0; index < 3; index += 1) {
      const contact = await prisma.contact.create({
        data: {
          companyName: `${marker}-${index}`,
          phone: `+7704${String(Date.now() + index).slice(-7)}`,
          strategyCode: marker,
        },
      });
      if (initialAutomation) {
        await prisma.automationSettings.update({
          where: { singletonKey: 'global' },
          data: initialAutomation,
        });
      }
      contactIds.push(contact.id);
    }
    const campaign = await prisma.campaign.create({
      data: {
        name: marker,
        status: CampaignStatus.RUNNING,
        sourceType: CampaignSourceType.ALL_CONTACTS,
        filters: {},
        settings: {
          create: {
            workingHoursStart: '00:00',
            workingHoursEnd: '00:00',
            dailyMessageLimit: 10,
            minDelaySeconds: 0,
            maxDelaySeconds: 0,
            timezone: 'UTC',
          },
        },
        targets: {
          create: contactIds.map((contactId) => ({
            contactId,
            strategyCode: marker,
            status: CampaignTargetStatus.QUEUED,
          })),
        },
      },
      include: { targets: true },
    });
    campaignId = campaign.id;

    const firstJob = await prisma.automationJob.create({
      data: {
        type: AutomationJobType.CAMPAIGN_TARGET,
        status: AutomationJobStatus.PROCESSING,
        runAt: new Date(0),
        lockedAt: new Date(Date.now() - 60_000),
        lockedBy: 'worker-a-stopped',
        campaignId,
        campaignTargetId: campaign.targets[0].id,
        deduplicationKey: `${marker}:0`,
      },
    });
    const recovered = await workerB.claim();
    expect(recovered?.id).toBe(firstJob.id);
    await workerB.execute(recovered!);

    for (let index = 1; index < campaign.targets.length; index += 1) {
      await prisma.automationJob.create({
        data: {
          type: AutomationJobType.CAMPAIGN_TARGET,
          runAt: new Date(0),
          campaignId,
          campaignTargetId: campaign.targets[index].id,
          deduplicationKey: `${marker}:${index}`,
        },
      });
      const claimed = index % 2 ? await workerA.claim() : await workerB.claim();
      expect(claimed).not.toBeNull();
      await (index % 2 ? workerA : workerB).execute(claimed!);
    }

    const snapshot = async () => ({
      conversations: await prisma.conversation.count({
        where: { campaignTargets: { some: { campaignId } } },
      }),
      aiMessages: await prisma.message.count({
        where: {
          conversation: { campaignTargets: { some: { campaignId } } },
          role: 'AI',
        },
      }),
      outbound: await prisma.whatsAppMessage.count({
        where: {
          conversation: { campaignTargets: { some: { campaignId } } },
          direction: WhatsAppMessageDirection.OUTBOUND,
        },
      }),
      runs: await prisma.aiRun.count({
        where: {
          conversation: { campaignTargets: { some: { campaignId } } },
          triggerMessageId: null,
        },
      }),
    });
    expect(await snapshot()).toEqual({
      conversations: 3,
      aiMessages: 3,
      outbound: 3,
      runs: 3,
    });
    expect(transportCalls).toBe(3);
    expect(
      await prisma.campaignTarget.count({
        where: { campaignId, messageSentAt: { not: null } },
      }),
    ).toBe(3);
    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } }))
        .processedCount,
    ).toBe(3);

    await workerA.enqueueCampaignTargets();
    expect(
      await prisma.automationJob.count({
        where: { campaignId, status: AutomationJobStatus.PENDING },
      }),
    ).toBe(0);
    expect(await snapshot()).toEqual({
      conversations: 3,
      aiMessages: 3,
      outbound: 3,
      runs: 3,
    });
    expect(transportCalls).toBe(3);
  });
});
