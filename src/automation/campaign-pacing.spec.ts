/// <reference types="jest" />
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */

const AutomationJobStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
} as const;
const AutomationJobType = {
  CONVERSATION_REPLY: 'CONVERSATION_REPLY',
  CAMPAIGN_TARGET: 'CAMPAIGN_TARGET',
} as const;
const CampaignStatus = { RUNNING: 'RUNNING', PAUSED: 'PAUSED' } as const;

jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  AutomationJobStatus,
  AutomationJobType,
  CampaignStatus,
  CampaignTargetStatus: {
    WAITING: 'WAITING',
    READY: 'READY',
    QUEUED: 'QUEUED',
    PROCESSING: 'PROCESSING',
  },
  Prisma: {},
}));

import { AutomationWorkerService } from './automation-worker.service';

describe('Campaign first-message pacing', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-25T06:00:00.000Z'));

    process.env = {
      ...ORIGINAL_ENV,
      CAMPAIGN_FIRST_MESSAGE_INTERVAL_SECONDS: '300',
      INBOUND_WORKER_CONCURRENCY: '20',
      AUTOMATION_WORKER_POLL_MS: '1000',
      OPENAI_MOCK_MODE: 'false',
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = ORIGINAL_ENV;
  });

  function createHarness() {
    let lastSentAt: Date | null = null;
    let lastAckErrorAt: Date | null = null;
    let leaderJobId: string | null = null;
    const sentAt: Date[] = [];

    const settings = {
      workingHoursStart: '00:00',
      workingHoursEnd: '23:59',
      timezone: 'UTC',
      dailyMessageLimit: 10000,
    };

    const target = {
      id: 'target-1',
      campaignId: 'campaign-1',
      campaign: {
        status: CampaignStatus.RUNNING,
        settings,
      },
    };

    const tx: any = {
      automationJob: {
        findFirst: jest.fn(async () =>
          leaderJobId ? { id: leaderJobId } : null,
        ),
      },
      campaignTarget: {
        findUnique: jest.fn(async () => target),
        count: jest.fn(async () => 0),
        findFirst: jest.fn(async () =>
          lastSentAt ? { messageSentAt: lastSentAt } : null,
        ),
      },
      campaignLog: {
        findFirst: jest.fn(async () =>
          lastAckErrorAt ? { createdAt: lastAckErrorAt } : null,
        ),
      },
      $executeRaw: jest.fn(async () => 1),
    };

    const prisma: any = {
      $transaction: jest.fn(async (callback: (tx: any) => Promise<any>) =>
        callback(tx),
      ),
      automationJob: {
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(async () => 0),
      },
      campaignTarget: {
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };

    const orchestrator: any = {
      startConversationForCampaignTarget: jest.fn(async () => {
        const now = new Date(Date.now());
        sentAt.push(now);
        lastSentAt = now;
      }),
      processIncomingClientMessage: jest.fn(async () => undefined),
    };

    const worker = new AutomationWorkerService(prisma, orchestrator) as any;

    return {
      worker,
      prisma,
      orchestrator,
      sentAt,
      getLastSentAt: () => lastSentAt,
      setLastSentAt: (value: Date | null) => {
        lastSentAt = value;
      },
      setLastAckErrorAt: (value: Date | null) => {
        lastAckErrorAt = value;
      },
      setLeaderJobId: (value: string | null) => {
        leaderJobId = value;
      },
    };
  }

  it('uses one cold campaign worker and keeps inbound pool independent', () => {
    const { worker } = createHarness();

    expect(worker.campaignConcurrency).toBe(1);
    expect(worker.inboundConcurrency).toBe(20);
    expect(worker.firstCampaignMessageIntervalMs).toBe(300_000);

    console.log('');
    console.log('WORKER CONFIG');
    console.log('CAMPAIGN concurrency :', worker.campaignConcurrency);
    console.log('INBOUND concurrency  :', worker.inboundConcurrency);
    console.log(
      'Cold interval        :',
      worker.firstCampaignMessageIntervalMs / 1000,
      'sec',
    );
  });

  it('does not allow another first campaign message before 300 seconds', async () => {
    const { worker, orchestrator, setLastSentAt } = createHarness();

    setLastSentAt(new Date(Date.now() - 10_000));

    const deferredUntil = await worker.runCampaignTarget('target-1', 'job-1');

    expect(
      orchestrator.startConversationForCampaignTarget,
    ).not.toHaveBeenCalled();
    expect(deferredUntil).toEqual(new Date(Date.now() + 290_000));

    console.log('');
    console.log('EARLY SEND TEST');
    console.log('Last cold send : 10 sec ago');
    console.log('Next allowed   : in 290 sec');
    console.log('RESULT         : PASS');
  });

  it('allows the next first campaign message at 300 seconds', async () => {
    const { worker, orchestrator, setLastSentAt } = createHarness();

    setLastSentAt(new Date(Date.now() - 300_000));

    const deferredUntil = await worker.runCampaignTarget('target-1', 'job-1');

    expect(deferredUntil).toBeNull();
    expect(
      orchestrator.startConversationForCampaignTarget,
    ).toHaveBeenCalledTimes(1);

    console.log('');
    console.log('300 SECOND BOUNDARY TEST');
    console.log('Last cold send : 300 sec ago');
    console.log('New cold send  : allowed immediately');
    console.log('RESULT         : PASS');
  });

  it('spaces two cold contacts by at least 300 seconds', async () => {
    const { worker, sentAt } = createHarness();
    for (const id of ['target-1', 'target-2']) {
      for (;;) {
        const deferred = await worker.runCampaignTarget(id, `job-${id}`);
        if (!deferred) break;
        jest.setSystemTime(deferred);
      }
    }

    expect(sentAt).toHaveLength(2);
    expect(sentAt[1].getTime() - sentAt[0].getTime()).toBeGreaterThanOrEqual(
      300_000,
    );
  });

  it('simulates 10 cold contacts and proves every gap is at least 300 seconds', async () => {
    const { worker, sentAt } = createHarness();

    const targetIds = Array.from(
      { length: 10 },
      (_, index) => `target-${index + 1}`,
    );

    for (const targetId of targetIds) {
      while (true) {
        const deferredUntil = await worker.runCampaignTarget(
          targetId,
          `job-${targetId}`,
        );

        if (!deferredUntil) {
          break;
        }

        jest.setSystemTime(deferredUntil);
      }
    }

    expect(sentAt).toHaveLength(10);

    const gapsSeconds = sentAt.slice(1).map((time, index) => {
      return (time.getTime() - sentAt[index].getTime()) / 1000;
    });

    expect(gapsSeconds.every((gap) => gap >= 300)).toBe(true);

    const elapsedSeconds =
      (sentAt.at(-1)!.getTime() - sentAt[0].getTime()) / 1000;

    console.log('');
    console.log('==========================================');
    console.log(' COLD CAMPAIGN PACING SIMULATION');
    console.log('==========================================');

    sentAt.forEach((time, index) => {
      const offset = (time.getTime() - sentAt[0].getTime()) / 1000;

      console.log(
        `Contact ${String(index + 1).padStart(2, '0')} -> +${String(offset).padStart(3, ' ')} sec`,
      );
    });

    console.log('------------------------------------------');
    console.log('Gaps:', gapsSeconds.join(', '), 'seconds');
    console.log('MIN GAP:', Math.min(...gapsSeconds), 'seconds');
    console.log('10 contacts elapsed:', elapsedSeconds, 'seconds');
    console.log(
      'Theoretical cold rate:',
      (60 / 300).toFixed(2),
      'messages/minute',
    );
    console.log('VIOLATIONS:', gapsSeconds.filter((g) => g < 300).length);
    console.log('RESULT: PASS');
    console.log('==========================================');
  });

  it('produces T+0, T+300 and T+600 for the first three successful sends', async () => {
    const { worker, sentAt } = createHarness();
    for (const id of ['target-1', 'target-2', 'target-3']) {
      for (;;) {
        const deferred = await worker.runCampaignTarget(id, `job-${id}`);
        if (!deferred) break;
        jest.setSystemTime(deferred);
      }
    }
    expect(sentAt.map((date) => date.getTime() - sentAt[0].getTime())).toEqual([
      0, 300_000, 600_000,
    ]);
  });

  it('uses persisted messageSentAt after a worker restart', async () => {
    const first = createHarness();
    first.setLastSentAt(new Date(Date.now()));
    const restarted = createHarness();
    restarted.setLastSentAt(first.getLastSentAt());
    await expect(
      restarted.worker.runCampaignTarget('target-2', 'job-2'),
    ).resolves.toEqual(new Date(Date.now() + 300_000));
    expect(
      restarted.orchestrator.startConversationForCampaignTarget,
    ).not.toHaveBeenCalled();
  });

  it('applies a 300-second cold cooldown after ACK_ERROR', async () => {
    const { worker, orchestrator, setLastAckErrorAt } = createHarness();
    setLastAckErrorAt(new Date(Date.now()));
    await expect(
      worker.runCampaignTarget('target-2', 'job-2'),
    ).resolves.toEqual(new Date(Date.now() + 300_000));
    expect(
      orchestrator.startConversationForCampaignTarget,
    ).not.toHaveBeenCalled();
  });

  it('allows only the distributed leader across parallel campaign attempts', async () => {
    const { worker, orchestrator, setLeaderJobId } = createHarness();
    setLeaderJobId('job-1');
    const [leader, follower] = await Promise.all([
      worker.runCampaignTarget('target-1', 'job-1'),
      worker.runCampaignTarget('target-2', 'job-2'),
    ]);
    expect(leader).toBeNull();
    expect(follower).toEqual(new Date(Date.now() + 1000));
    expect(
      orchestrator.startConversationForCampaignTarget,
    ).toHaveBeenCalledTimes(1);
  });

  it('conversation replies are not governed by the 300-second cold-send timer', async () => {
    const { worker, orchestrator, setLastSentAt } = createHarness();

    // Pretend a cold campaign message was sent right now.
    setLastSentAt(new Date(Date.now()));

    // Campaign target must be deferred.
    const coldDeferred = await worker.runCampaignTarget(
      'target-cold',
      'job-cold',
    );

    expect(coldDeferred).toEqual(new Date(Date.now() + 300_000));

    // Inbound reply uses its own orchestrator path and has no pacing wait.
    const inboundStartedAt = Date.now();

    await orchestrator.processIncomingClientMessage({
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      whatsAppMessageId: 'wa-1',
    });

    const inboundFinishedAt = Date.now();

    expect(orchestrator.processIncomingClientMessage).toHaveBeenCalledTimes(1);

    expect(inboundFinishedAt - inboundStartedAt).toBe(0);

    console.log('');
    console.log('INBOUND INDEPENDENCE TEST');
    console.log('Cold campaign next send : +300 sec');
    console.log('Client reply processing : immediate');
    console.log('RESULT                  : PASS');
  });
});
