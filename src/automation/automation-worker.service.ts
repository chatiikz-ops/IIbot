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
import { AutomationJobError } from './automation-job.error';

type ClaimedJob = {
  id: string;
  type: AutomationJobType;
  attempts: number;
  maxAttempts: number;
  campaignId: string | null;
  campaignTargetId: string | null;
  payload: Prisma.JsonValue | null;
  createdAt: Date;
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
  private campaignActive = 0;
  private inboundActive = 0;
  private lastQueueMetricsAt = 0;
  private readonly pollMs = Math.max(
    100,
    Number(process.env.AUTOMATION_WORKER_POLL_MS || 1000),
  );
  private readonly staleLockSeconds = Math.max(
    30,
    Number(process.env.AUTOMATION_JOB_STALE_LOCK_SECONDS || 300),
  );
  private readonly campaignConcurrency = Math.min(
    15,
    Math.max(1, Number(process.env.CAMPAIGN_WORKER_CONCURRENCY || 10)),
  );
  private readonly inboundConcurrency = Math.min(
    50,
    Math.max(1, Number(process.env.INBOUND_WORKER_CONCURRENCY || 20)),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: ConversationOrchestratorService,
  ) {}

  onApplicationBootstrap() {
    const explicitlyDisabled =
      process.env.AUTOMATION_WORKER_ENABLED === 'false';
    const disabledInTest =
      process.env.NODE_ENV === 'test' &&
      process.env.AUTOMATION_WORKER_ENABLED !== 'true';
    if (explicitlyDisabled || disabledInTest) {
      this.logger.warn({
        event: 'AUTOMATION_WORKER_DISABLED',
        reason: explicitlyDisabled ? 'EXPLICITLY_DISABLED' : 'TEST_DEFAULT',
      });
      return;
    }
    this.logger.log({
      event: 'AUTOMATION_WORKER_STARTED',
      enabled: true,
      workerId: this.workerId,
      intervalMs: this.pollMs,
      campaignConcurrency: this.campaignConcurrency,
      inboundConcurrency: this.inboundConcurrency,
    });
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
      await this.logQueueDepth();
      while (!this.stopping && this.inboundActive < this.inboundConcurrency) {
        const job = await this.claim(AutomationJobType.CONVERSATION_REPLY);
        if (!job) break;
        this.active += 1;
        this.inboundActive += 1;
        this.logCapacity();
        this.launchWithinBoundary(job);
      }
      while (!this.stopping && this.campaignActive < this.campaignConcurrency) {
        const job = await this.claim(AutomationJobType.CAMPAIGN_TARGET);
        if (!job) break;
        this.active += 1;
        this.campaignActive += 1;
        this.logCapacity();
        this.launchWithinBoundary(job);
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

  private launchWithinBoundary(job: ClaimedJob): void {
    void this.executeWithinBoundary(job).catch((error: unknown) => {
      try {
        this.logger.error({
          event: 'AUTOMATION_JOB_BOUNDARY_ESCAPE_SWALLOWED',
          jobId: job.id,
          type: job.type,
          errorCode: this.errorCode(error),
          error: this.errorMessage(error),
        });
      } catch {
        // Last-resort sink: an individual job cannot terminate the process.
      }
    });
  }

  private async executeWithinBoundary(job: ClaimedJob): Promise<void> {
    try {
      await this.execute(job);
    } catch (error) {
      try {
        this.logger.error({
          event: 'AUTOMATION_JOB_BOUNDARY_FAILURE',
          jobId: job.id,
          type: job.type,
          attempts: job.attempts,
          errorCode: this.errorCode(error),
          error: this.errorMessage(error),
        });
      } catch {
        // Recovery must still run when the logger transport itself fails.
      }
      await this.recoverBoundaryFailure(job, error);
    } finally {
      this.active -= 1;
      if (job.type === AutomationJobType.CAMPAIGN_TARGET) {
        this.campaignActive = Math.max(0, this.campaignActive - 1);
      } else {
        this.inboundActive = Math.max(0, this.inboundActive - 1);
      }
      this.logCapacity();
    }
  }

  private async recoverBoundaryFailure(job: ClaimedJob, error: unknown) {
    try {
      const exhausted = job.attempts >= job.maxAttempts;
      await this.prisma.automationJob.updateMany({
        where: {
          id: job.id,
          status: AutomationJobStatus.PROCESSING,
          lockedBy: this.workerId,
        },
        data: {
          status: exhausted
            ? AutomationJobStatus.FAILED
            : AutomationJobStatus.PENDING,
          runAt: exhausted ? undefined : new Date(Date.now() + 60_000),
          lockedAt: null,
          lockedBy: null,
          lastError: this.errorMessage(error).slice(0, 1000),
          errorCode: this.errorCode(error),
        },
      });
    } catch (recoveryError) {
      this.logger.error({
        event: 'AUTOMATION_JOB_BOUNDARY_RECOVERY_FAILED',
        jobId: job.id,
        type: job.type,
        error: this.errorMessage(recoveryError),
      });
    }
  }

  private async claim(type: AutomationJobType): Promise<ClaimedJob | null> {
    const rows = await this.prisma.$queryRaw<ClaimedJob[]>`
      WITH candidate AS (
        SELECT candidate_job."id" FROM "AutomationJob" candidate_job
        WHERE ((candidate_job."status" = 'PENDING' AND candidate_job."runAt" <= NOW())
          OR (candidate_job."status" = 'PROCESSING' AND candidate_job."lockedAt" < NOW() - (${this.staleLockSeconds} * INTERVAL '1 second')))
          AND candidate_job."type" = ${type}::"AutomationJobType"
          AND (${type}::"AutomationJobType" <> 'CONVERSATION_REPLY'
            OR candidate_job."conversationId" IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM "AutomationJob" active_job
              WHERE active_job."conversationId" = candidate_job."conversationId"
                AND active_job."type" = 'CONVERSATION_REPLY'
                AND active_job."status" = 'PROCESSING'
                AND active_job."id" <> candidate_job."id"
                AND active_job."lockedAt" >= NOW() - (${this.staleLockSeconds} * INTERVAL '1 second')
            ))
        ORDER BY candidate_job."runAt", candidate_job."createdAt"
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "AutomationJob" job SET
        "status" = 'PROCESSING', "lockedAt" = NOW(), "lockedBy" = ${this.workerId},
        "attempts" = job."attempts" + 1, "updatedAt" = NOW()
      FROM candidate WHERE job."id" = candidate."id"
      RETURNING job."id", job."type", job."attempts", job."maxAttempts", job."campaignId", job."campaignTargetId", job."payload", job."createdAt"
    `;
    if (rows[0]) {
      this.logger.log({
        event:
          rows[0].type === AutomationJobType.CAMPAIGN_TARGET
            ? 'CAMPAIGN_TARGET_CLAIMED'
            : 'AUTOMATION_JOB_CLAIMED',
        jobId: rows[0].id,
        type: rows[0].type,
        attempts: rows[0].attempts,
        campaignId: rows[0].campaignId,
        workerId: this.workerId,
      });
    }
    return rows[0] ?? null;
  }

  private logCapacity() {
    this.logger.debug({
      event: 'AUTOMATION_WORKER_CAPACITY',
      CAMPAIGN_ACTIVE_WORKERS: this.campaignActive,
      INBOUND_ACTIVE_WORKERS: this.inboundActive,
    });
  }

  private async logQueueDepth() {
    const now = Date.now();
    if (now - this.lastQueueMetricsAt < 10_000) return;
    this.lastQueueMetricsAt = now;
    const [campaignDepth, inboundDepth] = await Promise.all([
      this.prisma.automationJob.count({
        where: {
          type: AutomationJobType.CAMPAIGN_TARGET,
          status: AutomationJobStatus.PENDING,
        },
      }),
      this.prisma.automationJob.count({
        where: {
          type: AutomationJobType.CONVERSATION_REPLY,
          status: AutomationJobStatus.PENDING,
        },
      }),
    ]);
    this.logger.debug({ event: 'CAMPAIGN_QUEUE_DEPTH', depth: campaignDepth });
    this.logger.debug({ event: 'INBOUND_QUEUE_DEPTH', depth: inboundDepth });
  }

  private async execute(job: ClaimedJob) {
    try {
      if (job.type === AutomationJobType.CONVERSATION_REPLY) {
        const payload = job.payload as unknown as KnownInboundMessage & {
          mockScenario?: string;
        };
        this.logger.log({
          event: 'CONVERSATION_REPLY_PROCESSING',
          jobId: job.id,
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          attempts: job.attempts,
        });
        await this.orchestrator.processIncomingClientMessage(
          payload,
          payload.mockScenario,
          job.id,
        );
      } else if (
        job.type === AutomationJobType.CAMPAIGN_TARGET &&
        job.campaignTargetId
      ) {
        this.logger.log({
          event: 'CAMPAIGN_TARGET_STARTED',
          jobId: job.id,
          campaignId: job.campaignId,
          targetId: job.campaignTargetId,
        });
        const deferredUntil = await this.runCampaignTarget(
          job.campaignTargetId,
          job.id,
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
              errorCode: null,
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
          errorCode: null,
        },
      });
      if (job.type === AutomationJobType.CAMPAIGN_TARGET) {
        this.logger.log({
          event: 'CAMPAIGN_TARGET_COMPLETED',
          jobId: job.id,
          campaignId: job.campaignId,
          targetId: job.campaignTargetId,
        });
      }
      const createdAtMs = new Date(job.createdAt).getTime();
      this.logger.log({
        event:
          job.type === AutomationJobType.CAMPAIGN_TARGET
            ? 'CAMPAIGN_TARGET_LATENCY'
            : 'INBOUND_RESPONSE_LATENCY',
        jobId: job.id,
        latencyMs: Number.isFinite(createdAtMs)
          ? Math.max(0, Date.now() - createdAtMs)
          : null,
      });
    } catch (error) {
      const terminalCancellation =
        error instanceof AutomationJobError && error.kind === 'TERMINAL';
      const terminalFailure = this.isTerminalFailure(error);
      const exhausted = job.attempts >= job.maxAttempts;
      const status = terminalCancellation
        ? AutomationJobStatus.CANCELLED
        : terminalFailure || exhausted
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
          errorCode: this.errorCode(error),
          completedAt:
            status === AutomationJobStatus.CANCELLED ? new Date() : undefined,
        },
      });
      this.logger.warn({
        event:
          job.type === AutomationJobType.CAMPAIGN_TARGET
            ? 'CAMPAIGN_TARGET_FAILED'
            : 'AUTOMATION_JOB_FAILED',
        jobId: job.id,
        campaignId: job.campaignId,
        type: job.type,
        attempts: job.attempts,
        status,
      });
    }
  }

  private async runCampaignTarget(
    targetId: string,
    jobId?: string,
  ): Promise<Date | null> {
    const deferredUntil = await this.prisma.$transaction(
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
        return null;
      },
      { timeout: 10_000 },
    );
    if (deferredUntil) return deferredUntil;
    await this.orchestrator.startConversationForCampaignTarget(
      targetId,
      process.env.OPENAI_MOCK_MODE === 'true' ? 'QUALIFIED' : undefined,
      jobId,
    );
    return null;
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
    for (const [index, target] of targets.entries()) {
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
          // Spread otherwise-identical runAt values so a full pool does not
          // dispatch all outbound messages in the same millisecond.
          runAt: new Date(
            Date.now() +
              delay * 1000 +
              (index % this.campaignConcurrency) * 100,
          ),
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

  private errorMessage(error: unknown) {
    if (error instanceof AutomationJobError)
      return `${error.code}: ${error.message}`;
    return error instanceof Error ? error.message : 'Unknown worker error';
  }

  private errorCode(error: unknown) {
    const coded = this.findCodedError(error);
    if (coded) return coded.code;
    const statusError = error as { getStatus?: () => unknown } | null;
    if (
      statusError &&
      typeof statusError.getStatus === 'function' &&
      Number(statusError.getStatus()) === 408
    )
      return 'TIMEOUT';
    if (error instanceof Error && error.name) return error.name;
    return 'UNKNOWN';
  }

  private isTerminalFailure(error: unknown) {
    return this.findCodedError(error)?.retryable === false;
  }

  private findCodedError(
    error: unknown,
  ): { code: string; retryable?: boolean } | null {
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (current && !seen.has(current)) {
      seen.add(current);
      if (current instanceof AutomationJobError) {
        return {
          code: current.code,
          retryable: current.kind === 'RETRYABLE',
        };
      }
      if (typeof current !== 'object') return null;
      const candidate = current as {
        code?: unknown;
        retryable?: unknown;
        cause?: unknown;
      };
      if (typeof candidate.code === 'string') {
        return {
          code: candidate.code,
          retryable:
            typeof candidate.retryable === 'boolean'
              ? candidate.retryable
              : undefined,
        };
      }
      current = candidate.cause;
    }
    return null;
  }
}
