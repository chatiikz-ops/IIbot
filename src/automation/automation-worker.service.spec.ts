/// <reference types="jest" />

import { BadGatewayException, RequestTimeoutException } from '@nestjs/common';

const AutomationJobStatus = {
  PROCESSING: 'PROCESSING',
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
const AutomationJobType = {
  CONVERSATION_REPLY: 'CONVERSATION_REPLY',
  CAMPAIGN_TARGET: 'CAMPAIGN_TARGET',
} as const;

jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  AutomationJobStatus,
  AutomationJobType,
  CampaignStatus: {
    PAUSED: 'PAUSED',
    RUNNING: 'RUNNING',
  },
  CampaignTargetStatus: {
    WAITING: 'WAITING',
    READY: 'READY',
    QUEUED: 'QUEUED',
    PROCESSING: 'PROCESSING',
    ERROR: 'ERROR',
  },
  Prisma: {},
}));
import type { PrismaService } from '../prisma/prisma.service';
import type { ConversationOrchestratorService } from './conversation-orchestrator.service';
import { AutomationWorkerService } from './automation-worker.service';

type TestJob = {
  id: string;
  type: (typeof AutomationJobType)[keyof typeof AutomationJobType];
  attempts: number;
  maxAttempts: number;
  campaignTargetId: string | null;
  payload: null | Record<string, string>;
};

type WorkerInternals = {
  active: number;
  launchWithinBoundary(job: TestJob): void;
  executeWithinBoundary(job: TestJob): Promise<void>;
  runCampaignTarget(targetId: string): Promise<Date | null>;
  claim(type: string): Promise<TestJob | null>;
};

const invalidOutput = () =>
  new BadGatewayException('invalid structured output', {
    cause: Object.assign(new Error('invalid output'), {
      code: 'INVALID_OUTPUT',
      retryable: false,
    }),
  });

describe('AutomationWorkerService failure boundary', () => {
  const createWorker = () => {
    const automationJob = {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };

    const campaignTarget = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };

    const orchestrator = {
      processIncomingClientMessage: jest.fn().mockResolvedValue(undefined),
    };

    const worker = new AutomationWorkerService(
      {
        automationJob,
        campaignTarget,
      } as unknown as PrismaService,
      orchestrator as unknown as ConversationOrchestratorService,
    ) as unknown as WorkerInternals;

    return {
      worker,
      automationJob,
      campaignTarget,
      orchestrator,
    };
  };

  it('requeues a pacing-deferred campaign job without marking it failed', async () => {
    const { worker, automationJob, campaignTarget } = createWorker();
    const deferredUntil = new Date(Date.now() + 45_000);
    jest.spyOn(worker, 'runCampaignTarget').mockResolvedValue(deferredUntil);
    worker.active = 1;

    await worker.executeWithinBoundary({
      id: 'deferred-job',
      type: AutomationJobType.CAMPAIGN_TARGET,
      attempts: 1,
      maxAttempts: 3,
      campaignTargetId: 'target-1',
      payload: null,
    });

    expect(automationJob.update).toHaveBeenCalledWith({
      where: { id: 'deferred-job' },
      // Jest asymmetric matchers are intentionally typed as any.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        status: AutomationJobStatus.PENDING,
        runAt: deferredUntil,
        attempts: { decrement: 1 },
        lastError: null,
      }),
    });
    expect(campaignTarget.updateMany).not.toHaveBeenCalled();
  });

  it.each(['WHATSAPP_NOT_CONNECTED', 'WHATSAPP_RUNTIME_STABILIZING'])(
    'defers pre-send %s without consuming attempts',
    async (code) => {
      const { worker, automationJob, campaignTarget } = createWorker();
      jest.spyOn(worker, 'runCampaignTarget').mockRejectedValue(
        Object.assign(new Error(code), {
          response: { code },
        }),
      );
      worker.active = 1;

      await worker.executeWithinBoundary({
        id: `job-${code}`,
        type: AutomationJobType.CAMPAIGN_TARGET,
        attempts: 3,
        maxAttempts: 3,
        campaignTargetId: 'target-1',
        payload: null,
      });

      expect(automationJob.update).toHaveBeenCalledWith({
        where: { id: `job-${code}` },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          status: AutomationJobStatus.PENDING,
          attempts: { decrement: 1 },
          errorCode: code,
          lockedAt: null,
          lockedBy: null,
        }),
      });
      expect(campaignTarget.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({
            status: 'QUEUED',
          }),
        }),
      );
    },
  );

  it('contains an exhausted OpenAI timeout and can process the next campaign job', async () => {
    const { worker, automationJob } = createWorker();
    const runCampaignTarget = jest
      .spyOn(worker, 'runCampaignTarget')
      .mockRejectedValueOnce(
        new RequestTimeoutException('Запрос к OpenAI превысил время ожидания'),
      )
      .mockResolvedValueOnce(null);
    worker.active = 2;

    await expect(
      worker.executeWithinBoundary({
        id: 'timed-out-job',
        type: AutomationJobType.CAMPAIGN_TARGET,
        attempts: 3,
        maxAttempts: 3,
        campaignTargetId: 'target-1',
        payload: null,
      }),
    ).resolves.toBeUndefined();
    await expect(
      worker.executeWithinBoundary({
        id: 'next-job',
        type: AutomationJobType.CAMPAIGN_TARGET,
        attempts: 1,
        maxAttempts: 3,
        campaignTargetId: 'target-2',
        payload: null,
      }),
    ).resolves.toBeUndefined();

    expect(runCampaignTarget).toHaveBeenCalledTimes(2);
    expect(automationJob.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: 'timed-out-job' },
        // Jest asymmetric matchers are intentionally typed as any.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          status: AutomationJobStatus.FAILED,
          errorCode: 'TIMEOUT',
        }),
      }),
    );
    expect(automationJob.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'next-job' },
        // Jest asymmetric matchers are intentionally typed as any.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          status: AutomationJobStatus.COMPLETED,
        }),
      }),
    );
    expect(worker.active).toBe(0);
  });

  it('contains failure bookkeeping errors at the outer worker boundary', async () => {
    const { worker, automationJob } = createWorker();
    jest
      .spyOn(worker, 'runCampaignTarget')
      .mockRejectedValue(
        new RequestTimeoutException('Запрос к OpenAI превысил время ожидания'),
      );
    automationJob.update.mockRejectedValue(new Error('database unavailable'));
    automationJob.updateMany.mockRejectedValue(
      new Error('database still unavailable'),
    );
    worker.active = 1;

    await expect(
      worker.executeWithinBoundary({
        id: 'boundary-job',
        type: AutomationJobType.CAMPAIGN_TARGET,
        attempts: 1,
        maxAttempts: 3,
        campaignTargetId: 'target-1',
        payload: null,
      }),
    ).resolves.toBeUndefined();
    expect(automationJob.updateMany).toHaveBeenCalledTimes(1);
    expect(worker.active).toBe(0);
  });

  it('contains a conversation reply timeout and leaves the worker alive', async () => {
    const { worker, orchestrator } = createWorker();
    orchestrator.processIncomingClientMessage.mockRejectedValue(
      new RequestTimeoutException('Запрос к OpenAI превысил время ожидания'),
    );
    worker.active = 1;

    await expect(
      worker.executeWithinBoundary({
        id: 'reply-job',
        type: AutomationJobType.CONVERSATION_REPLY,
        attempts: 1,
        maxAttempts: 3,
        campaignTargetId: null,
        payload: {
          contactId: 'contact-1',
          conversationId: 'conversation-1',
          messageId: 'message-1',
          whatsAppMessageId: 'wa-1',
        },
      }),
    ).resolves.toBeUndefined();
    expect(worker.active).toBe(0);
  });

  it('marks INVALID_OUTPUT terminal FAILED and processes the next campaign job', async () => {
    const { worker, automationJob } = createWorker();
    jest
      .spyOn(worker, 'runCampaignTarget')
      .mockRejectedValueOnce(invalidOutput())
      .mockResolvedValueOnce(null);
    worker.active = 2;

    await worker.executeWithinBoundary({
      id: 'invalid-output-job',
      type: AutomationJobType.CAMPAIGN_TARGET,
      attempts: 1,
      maxAttempts: 3,
      campaignTargetId: 'target-1',
      payload: null,
    });
    await worker.executeWithinBoundary({
      id: 'following-job',
      type: AutomationJobType.CAMPAIGN_TARGET,
      attempts: 1,
      maxAttempts: 3,
      campaignTargetId: 'target-2',
      payload: null,
    });

    expect(automationJob.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: 'invalid-output-job' },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          status: AutomationJobStatus.FAILED,
          errorCode: 'INVALID_OUTPUT',
        }),
      }),
    );
    expect(automationJob.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'following-job' },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          status: AutomationJobStatus.COMPLETED,
        }),
      }),
    );
  });

  it('contains INVALID_OUTPUT for CONVERSATION_REPLY', async () => {
    const { worker, orchestrator, automationJob } = createWorker();
    orchestrator.processIncomingClientMessage.mockRejectedValue(
      invalidOutput(),
    );
    worker.active = 1;

    await worker.executeWithinBoundary({
      id: 'invalid-reply-job',
      type: AutomationJobType.CONVERSATION_REPLY,
      attempts: 1,
      maxAttempts: 3,
      campaignTargetId: null,
      payload: {
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        whatsAppMessageId: 'wa-1',
      },
    });

    expect(automationJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          status: AutomationJobStatus.FAILED,
          errorCode: 'INVALID_OUTPUT',
        }),
      }),
    );
  });

  it('swallows a failure of both job bookkeeping layers without unhandledRejection', async () => {
    const { worker, automationJob } = createWorker();
    jest
      .spyOn(worker, 'runCampaignTarget')
      .mockRejectedValue(new Error('boom'));
    automationJob.update.mockRejectedValue(new Error('bookkeeping failed'));
    automationJob.updateMany.mockRejectedValue(new Error('recovery failed'));
    worker.active = 1;
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    worker.launchWithinBoundary({
      id: 'last-resort-job',
      type: AutomationJobType.CAMPAIGN_TARGET,
      attempts: 1,
      maxAttempts: 3,
      campaignTargetId: 'target-1',
      payload: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(worker.active).toBe(0);
  });

  it('contains an unexpected orchestrator error', async () => {
    const { worker, orchestrator } = createWorker();
    orchestrator.processIncomingClientMessage.mockRejectedValue(
      new Error('unexpected runtime failure'),
    );
    worker.active = 1;

    await expect(
      worker.executeWithinBoundary({
        id: 'unexpected-job',
        type: AutomationJobType.CONVERSATION_REPLY,
        attempts: 1,
        maxAttempts: 1,
        campaignTargetId: null,
        payload: {
          contactId: 'contact-1',
          conversationId: 'conversation-1',
          messageId: 'message-1',
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('AutomationWorkerService campaign claim eligibility', () => {
  it('claims campaign jobs only when their campaign is RUNNING', async () => {
    let sql = '';
    const queryRaw = jest.fn((strings: TemplateStringsArray) => {
      sql = strings.join('?');
      return Promise.resolve([]);
    });
    const worker = new AutomationWorkerService(
      { $queryRaw: queryRaw } as unknown as PrismaService,
      {} as ConversationOrchestratorService,
    ) as unknown as WorkerInternals;

    await worker.claim(AutomationJobType.CAMPAIGN_TARGET);

    expect(sql).toContain('FROM "Campaign" campaign');
    expect(sql).toContain('campaign."status" = \'RUNNING\'');
  });
});
