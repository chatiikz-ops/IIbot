import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { AutomationWorkerService } from '../src/automation/automation-worker.service';
import { CampaignsService } from '../src/campaigns/campaigns.service';
import type { ConversationOrchestratorService } from '../src/automation/conversation-orchestrator.service';
import {
  AutomationJobStatus,
  AutomationJobType,
  CampaignSourceType,
  CampaignStatus,
  CampaignTargetStatus,
} from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';

type WorkerInternals = {
  claim(): Promise<{ id: string } | null>;
  runCampaignTarget(targetId: string): Promise<Date | null>;
};

describe('Durable campaign worker concurrency (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let campaigns: CampaignsService;
  const marker = `worker-e2e-${Date.now()}`;
  const campaignIds: string[] = [];
  const contactIds: string[] = [];
  const jobIds: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AUTOMATION_WORKER_ENABLED = 'false';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    campaigns = app.get(CampaignsService);
  });

  afterAll(async () => {
    await prisma.automationJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await app.close();
  });

  it('FOR UPDATE SKIP LOCKED allows exactly one claim for one job', async () => {
    const job = await prisma.automationJob.create({
      data: {
        type: AutomationJobType.CONVERSATION_REPLY,
        status: AutomationJobStatus.PENDING,
        runAt: new Date(0),
        deduplicationKey: `${marker}:single-claim`,
      },
    });
    jobIds.push(job.id);
    const orchestrator = {} as ConversationOrchestratorService;
    const workerA = new AutomationWorkerService(
      prisma,
      orchestrator,
    ) as unknown as WorkerInternals;
    const workerB = new AutomationWorkerService(
      prisma,
      orchestrator,
    ) as unknown as WorkerInternals;
    const claims = await Promise.all([workerA.claim(), workerB.claim()]);
    expect(claims.filter((claim) => claim?.id === job.id)).toHaveLength(1);
    expect(
      (await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } }))
        .attempts,
    ).toBe(1);
  });

  it('a second worker recovers a stale PROCESSING lock', async () => {
    const job = await prisma.automationJob.create({
      data: {
        type: AutomationJobType.CONVERSATION_REPLY,
        status: AutomationJobStatus.PROCESSING,
        runAt: new Date(0),
        lockedAt: new Date(Date.now() - 600_000),
        lockedBy: 'stopped-worker',
        deduplicationKey: `${marker}:stale`,
      },
    });
    jobIds.push(job.id);
    const worker = new AutomationWorkerService(
      prisma,
      {} as ConversationOrchestratorService,
    ) as unknown as WorkerInternals;
    const claim = await worker.claim();
    expect(claim?.id).toBe(job.id);
    const recovered = await prisma.automationJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(recovered.lockedBy).not.toBe('stopped-worker');
    expect(recovered.attempts).toBe(1);
  });

  it('two worker instances cannot exceed dailyMessageLimit=2 with 5 targets', async () => {
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
            dailyMessageLimit: 2,
            minDelaySeconds: 0,
            maxDelaySeconds: 0,
            timezone: 'Asia/Almaty',
          },
        },
      },
    });
    campaignIds.push(campaign.id);
    const targets: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const contact = await prisma.contact.create({
        data: {
          companyName: `${marker}-${index}`,
          phone: `+7701${String(Date.now() + index).slice(-7)}`,
          strategyCode: 'TEST',
        },
      });
      contactIds.push(contact.id);
      const target = await prisma.campaignTarget.create({
        data: {
          campaignId: campaign.id,
          contactId: contact.id,
          status: CampaignTargetStatus.QUEUED,
          strategyCode: 'TEST',
        },
      });
      targets.push(target.id);
    }
    let outboundCalls = 0;
    const orchestrator = {
      startConversationForCampaignTarget: async (targetId: string) => {
        outboundCalls += 1;
        await prisma.campaignTarget.update({
          where: { id: targetId },
          data: {
            status: CampaignTargetStatus.WAITING_REPLY,
            messageSentAt: new Date(),
          },
        });
      },
    } as unknown as ConversationOrchestratorService;
    const workers = [
      new AutomationWorkerService(
        prisma,
        orchestrator,
      ) as unknown as WorkerInternals,
      new AutomationWorkerService(
        prisma,
        orchestrator,
      ) as unknown as WorkerInternals,
    ];
    const results = await Promise.all(
      targets.map((targetId, index) =>
        workers[index % 2].runCampaignTarget(targetId),
      ),
    );
    expect(outboundCalls).toBe(2);
    expect(results.filter((result) => result === null)).toHaveLength(2);
    expect(results.filter((result) => result instanceof Date)).toHaveLength(3);
    expect(
      await prisma.campaignTarget.count({
        where: { campaignId: campaign.id, messageSentAt: { not: null } },
      }),
    ).toBe(2);
  });

  it('campaign pause/resume/complete transitions remain restart-safe', async () => {
    const campaign = await prisma.campaign.create({
      data: {
        name: `${marker}-lifecycle`,
        status: CampaignStatus.RUNNING,
        sourceType: CampaignSourceType.ALL_CONTACTS,
        filters: {},
      },
    });
    campaignIds.push(campaign.id);
    expect((await campaigns.pause(campaign.id)).status).toBe(
      CampaignStatus.PAUSED,
    );
    expect((await campaigns.resume(campaign.id)).status).toBe(
      CampaignStatus.RUNNING,
    );
    expect((await campaigns.complete(campaign.id)).status).toBe(
      CampaignStatus.COMPLETED,
    );
  });
});
