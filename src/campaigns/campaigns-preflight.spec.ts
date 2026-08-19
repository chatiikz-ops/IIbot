/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../generated/prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class {} },
}));

import { ConflictException } from '@nestjs/common';
import {
  CampaignStatus,
  PromptStrategyStatus,
} from '../generated/prisma/enums';
import { CampaignsService } from './campaigns.service';

describe('CampaignsService preflight', () => {
  const campaign = {
    id: 'campaign',
    status: CampaignStatus.DRAFT,
    selectedCount: 1,
    settings: {
      workingHoursStart: '09:00',
      workingHoursEnd: '18:00',
      dailyMessageLimit: 10,
      minDelaySeconds: 1,
      maxDelaySeconds: 2,
      timezone: 'Asia/Almaty',
    },
    targets: [
      {
        strategyCode: 'GENERIC_GENERAL',
        contact: {
          deletedAt: null,
          outreachEligible: true,
          strategyCode: 'GENERIC_GENERAL',
          classifiedAt: new Date(),
        },
      },
    ],
  };

  function createService(options?: {
    automation?: boolean;
    sending?: boolean;
    whatsapp?: boolean;
    strategy?: boolean;
  }) {
    const prisma = {
      campaign: {
        findUnique: jest.fn().mockResolvedValue(campaign),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(campaign),
      },
      automationSettings: {
        findUnique: jest.fn().mockResolvedValue({
          enabled: options?.automation ?? true,
          campaignSendingEnabled: options?.sending ?? true,
        }),
      },
      promptStrategy: {
        findMany: jest.fn().mockResolvedValue(
          options?.strategy === false
            ? []
            : [
                {
                  code: 'GENERIC_GENERAL',
                  status: PromptStrategyStatus.ACTIVE,
                  activeVersionId: 'version',
                },
              ],
        ),
      },
      campaignLog: { create: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn((operation) => operation(prisma)),
    };
    const whatsapp = {
      getStatus: jest.fn().mockResolvedValue({
        connected: options?.whatsapp ?? true,
        lifecycleState: options?.whatsapp === false ? 'DISCONNECTED' : 'READY',
      }),
    };
    return {
      service: new CampaignsService(
        prisma as never,
        {} as never,
        whatsapp as never,
      ),
      prisma,
    };
  }

  it('reports structured blockers without changing campaign state', async () => {
    const { service, prisma } = createService({
      automation: false,
      sending: false,
      whatsapp: false,
      strategy: false,
    });
    const result = await service.preflight('campaign');
    expect(result.ready).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'AUTOMATION_DISABLED',
        'CAMPAIGN_SENDING_DISABLED',
        'WHATSAPP_NOT_CONNECTED',
        'STRATEGY_NOT_READY',
      ]),
    );
    expect(prisma.campaign.updateMany).not.toHaveBeenCalled();
    await expect(service.start('campaign')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('atomically claims a ready campaign on start', async () => {
    const { service, prisma } = createService();
    await expect(service.preflight('campaign')).resolves.toMatchObject({
      ready: true,
      targetCount: 1,
      whatsappConnected: true,
    });
    await service.start('campaign');
    expect(prisma.campaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'campaign' }),
      }),
    );
  });
});
