import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AutomationJobStatus,
  AutomationJobType,
  CampaignStatus,
  CampaignTargetStatus,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { KnownInboundMessage } from '../whatsapp/whatsapp-messaging.service';
import { ConversationOrchestratorService } from './conversation-orchestrator.service';
import { campaignWindow } from './campaign-time.util';

type ClaimedJob = {
  id: string;
  type: AutomationJobType;
  attempts: number;
  maxAttempts: number;
  campaignTargetId: string | null;
  payload: Prisma.JsonValue | null;
};

@Injectable()
export class AutomationWorkerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(AutomationWorkerService.name);
  private readonly workerId = `${process.pid}:${randomUUID()}`;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private active = 0;
  private readonly pollMs = Math.max(
    100,
    Number(process.env.AUTOMATION_WORKER_POLL_MS || 1000),
  );
  private readonly staleLockSeconds = Math.max(
    30,
    Number(process.env.AUTOMATION_JOB_STALE_LOCK_SECONDS || 300),
  );
  private readonly concurrency = Math.min(
    10,
    Math.max(1, Number(process.env.AUTOMATION_WORKER_CONCURRENCY || 3)),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: ConversationOrchestratorService,
  ) {}

  onApplicationBootstrap() {
    if (
      process.env.AUTOMATION_WORKER_ENABLED === 'false' ||
      (process.env.NODE_ENV === 'test' &&
        process.env.AUTOMATION_WORKER_ENABLED !== 'true')
    )
      return;
    this.schedule(0);
  }

  async onApplicationShutdown() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.active > 0)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }

  private schedule(delay: number) {
    if (!this.stopping) this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick() {
    try {
      await this.enqueueCampaignTargets();
      while (!this.stopping && this.active < this.concurrency) {
        const job = await this.claim();
        if (!job) break;
        this.active += 1;
        void this.execute(job).finally(() => {
          this.active -= 1;
        });
      }
    } catch (error) {
      this.logger.error({
        event: 'AUTOMATION_WORKER_POLL_FAILED',
        error: this.errorMessage(error),
      });
    } finally {
      this.schedule(this.pollMs);
    }
  }

  private async claim(): Promise<ClaimedJob | null> {
    const rows = await this.prisma.$queryRaw<ClaimedJob[]>`
      WITH candidate AS (
        SELECT "id" FROM "AutomationJob"
        WHERE (("status" = 'PENDING' AND "runAt" <= NOW())
          OR ("status" = 'PROCESSING' AND "lockedAt" < NOW() - (${this.staleLockSeconds} * INTERVAL '1 second')))
        ORDER BY "runAt", "createdAt"
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "AutomationJob" job SET
        "status" = 'PROCESSING', "lockedAt" = NOW(), "lockedBy" = ${this.workerId},
        "attempts" = job."attempts" + 1, "updatedAt" = NOW()
      FROM candidate WHERE job."id" = candidate."id"
      RETURNING job."id", job."type", job."attempts", job."maxAttempts", job."campaignTargetId", job."payload"
    `;
    return rows[0] ?? null;
  }

  private async execute(job: ClaimedJob) {
    try {
      if (job.type === AutomationJobType.CONVERSATION_REPLY) {
        const payload = job.payload as unknown as KnownInboundMessage & {
          mockScenario?: string;
        };
        await this.orchestrator.processIncomingClientMessage(
          payload,
          payload.mockScenario,
        );
      } else if (
        job.type === AutomationJobType.CAMPAIGN_TARGET &&
        job.campaignTargetId
      ) {
        const deferredUntil = await this.runCampaignTarget(
          job.campaignTargetId,
        );
        if (deferredUntil) {
          await this.prisma.automationJob.update({
            where: { id: job.id },
            data: {
              status: AutomationJobStatus.PENDING,
              runAt: deferredUntil,
              attempts: { decrement: 1 },
              lockedAt: null,
              lockedBy: null,
              lastError: null,
            },
          });
          return;
        }
      }
      await this.prisma.automationJob.update({
        where: { id: job.id },
        data: {
          status: AutomationJobStatus.COMPLETED,
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
    } catch (error) {
      const terminal = this.isBusinessSkip(error);
      const exhausted = job.attempts >= job.maxAttempts;
      const status = terminal
        ? AutomationJobStatus.CANCELLED
        : exhausted
          ? AutomationJobStatus.FAILED
          : AutomationJobStatus.PENDING;
      const backoff = job.attempts <= 1 ? 15_000 : 60_000;
      await this.prisma.automationJob.update({
        where: { id: job.id },
        data: {
          status,
          runAt:
            status === AutomationJobStatus.PENDING
              ? new Date(Date.now() + backoff)
              : undefined,
          lockedAt: null,
          lockedBy: null,
          lastError: this.errorMessage(error).slice(0, 1000),
          completedAt:
            status === AutomationJobStatus.CANCELLED ? new Date() : undefined,
        },
      });
      this.logger.warn({
        event: 'AUTOMATION_JOB_FAILED',
        jobId: job.id,
        type: job.type,
        attempts: job.attempts,
        status,
      });
    }
  }

  private async runCampaignTarget(targetId: string): Promise<Date | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const target = await tx.campaignTarget.findUnique({
          where: { id: targetId },
          include: { campaign: { include: { settings: true } } },
        });
        if (!target?.campaign.settings) {
          return null;
        }
        if (target.campaign.status === CampaignStatus.PAUSED) {
          return new Date(Date.now() + this.pollMs);
        }
        if (target.campaign.status !== CampaignStatus.RUNNING) return null;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campaign-quota:${target.campaignId}`}))`;
        const settings = target.campaign.settings;
        const window = campaignWindow(
          new Date(),
          settings.workingHoursStart,
          settings.workingHoursEnd,
          settings.timezone,
        );
        if (!window.withinWindow) return window.nextRunAt;
        const sentToday = await tx.campaignTarget.count({
          where: {
            campaignId: target.campaignId,
            messageSentAt: { gte: window.dayStart, lt: window.dayEnd },
          },
        });
        if (sentToday >= settings.dailyMessageLimit) {
          return window.nextDayStart;
        }
        await this.orchestrator.startConversationForCampaignTarget(
          targetId,
          process.env.OPENAI_MOCK_MODE === 'true' ? 'QUALIFIED' : undefined,
        );
        return null;
      },
      { timeout: 120_000 },
    );
  }

  private async enqueueCampaignTargets() {
    const targets = await this.prisma.campaignTarget.findMany({
      where: {
        status: {
          in: [CampaignTargetStatus.WAITING, CampaignTargetStatus.READY],
        },
        campaign: { status: CampaignStatus.RUNNING, settings: { isNot: null } },
      },
      include: { campaign: { include: { settings: true } } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    for (const target of targets) {
      const settings = target.campaign.settings!;
      const delay =
        settings.minDelaySeconds +
        Math.floor(
          Math.random() *
            (settings.maxDelaySeconds - settings.minDelaySeconds + 1),
        );
      await this.prisma.automationJob.upsert({
        where: { deduplicationKey: `campaign-target:${target.id}` },
        create: {
          type: AutomationJobType.CAMPAIGN_TARGET,
          runAt: new Date(Date.now() + delay * 1000),
          contactId: target.contactId,
          campaignId: target.campaignId,
          campaignTargetId: target.id,
          deduplicationKey: `campaign-target:${target.id}`,
        },
        update: {},
      });
      await this.prisma.campaignTarget.updateMany({
        where: {
          id: target.id,
          status: {
            in: [CampaignTargetStatus.WAITING, CampaignTargetStatus.READY],
          },
        },
        data: { status: CampaignTargetStatus.QUEUED, queuedAt: new Date() },
      });
    }
  }

  private isBusinessSkip(error: unknown) {
    const status =
      typeof error === 'object' && error && 'getStatus' in error
        ? Number((error as { getStatus(): number }).getStatus())
        : 0;
    return status === 403 || status === 404 || status === 409;
  }
  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'Unknown worker error';
  }
}
