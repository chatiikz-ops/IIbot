/* eslint-disable @typescript-eslint/no-unsafe-assignment */
jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: {},
}));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  CampaignStatus,
  CampaignTargetStatus,
} from '../generated/prisma/enums';
import { CampaignsService } from './campaigns.service';

describe('CampaignsService worker lifecycle cleanup', () => {
  const createService = (status: CampaignStatus) => {
    const automationJob = {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      count: jest.fn().mockResolvedValue(2),
    };
    const campaignTarget = {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    };
    const campaign = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'campaign-1',
        status,
        startedAt: new Date(),
      }),
      update: jest.fn(({ data }: { data: { status: CampaignStatus } }) =>
        Promise.resolve({ id: 'campaign-1', ...data }),
      ),
    };
    const tx = {
      campaign,
      automationJob,
      campaignTarget,
      campaignLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      campaign,
      $transaction: jest.fn(
        (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    return {
      service: new CampaignsService(prisma as never, {} as never, {} as never),
      automationJob,
      campaignTarget,
    };
  };

  it('cancels PENDING and PROCESSING jobs without deleting them', async () => {
    const { service, automationJob, campaignTarget } = createService(
      CampaignStatus.RUNNING,
    );

    await service.cancel('campaign-1');

    expect(automationJob.updateMany).toHaveBeenCalledWith({
      where: {
        campaignId: 'campaign-1',
        type: 'CAMPAIGN_TARGET',
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      data: expect.objectContaining({
        status: 'CANCELLED',
        completedAt: expect.any(Date),
        lockedAt: null,
        lockedBy: null,
      }),
    });
    expect(campaignTarget.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: CampaignTargetStatus.SKIPPED,
          completedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('does not mutate attempts when pausing pending jobs', async () => {
    const { service, automationJob } = createService(CampaignStatus.RUNNING);
    await service.pause('campaign-1');
    expect(automationJob.updateMany).not.toHaveBeenCalled();
    expect(automationJob.count).toHaveBeenCalled();
  });

  it('releases pending jobs on resume', async () => {
    const { service, automationJob } = createService(CampaignStatus.PAUSED);
    await service.resume('campaign-1');
    expect(automationJob.updateMany).toHaveBeenCalledWith({
      where: {
        campaignId: 'campaign-1',
        type: 'CAMPAIGN_TARGET',
        status: 'PENDING',
      },
      data: { runAt: expect.any(Date) },
    });
  });
});
