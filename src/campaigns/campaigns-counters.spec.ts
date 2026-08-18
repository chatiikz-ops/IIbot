import { CampaignsService } from './campaigns.service';

jest.mock('../generated/prisma/client', () => ({ Prisma: {} }));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

describe('Campaign counters source of truth', () => {
  it('recomputes selected, processed, replied and terminal outcomes independently', async () => {
    const update = jest.fn(() => Promise.resolve({}));
    const updateMany = jest.fn(() => Promise.resolve({ count: 0 }));
    const tx = {
      campaignTarget: {
        groupBy: jest.fn(() =>
          Promise.resolve([
            { status: 'WAITING_REPLY', _count: { _all: 2 } },
            { status: 'LEAD', _count: { _all: 1 } },
            { status: 'HANDOFF', _count: { _all: 1 } },
            { status: 'REJECTED', _count: { _all: 1 } },
            { status: 'ERROR', _count: { _all: 1 } },
          ]),
        ),
        count: jest.fn(() => Promise.resolve(3)),
      },
      campaign: { update, updateMany },
    };
    const service = new CampaignsService({} as never, {} as never, {} as never);

    await (
      service as unknown as {
        recalculateCounters(client: unknown, campaignId: string): Promise<void>;
      }
    ).recalculateCounters(tx, 'campaign-1');

    expect(update).toHaveBeenCalledWith({
      where: { id: 'campaign-1' },
      data: {
        selectedCount: 6,
        processedCount: 6,
        repliedCount: 3,
        leadCount: 1,
        rejectedCount: 1,
        handoffCount: 1,
      },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('auto-completes only when no target is waiting for work or reply', async () => {
    const updateMany = jest.fn(() => Promise.resolve({ count: 1 }));
    const tx = {
      campaignTarget: {
        groupBy: jest.fn(() =>
          Promise.resolve([
            { status: 'LEAD', _count: { _all: 1 } },
            { status: 'REJECTED', _count: { _all: 1 } },
          ]),
        ),
        count: jest.fn(() => Promise.resolve(2)),
      },
      campaign: {
        update: jest.fn(() => Promise.resolve({})),
        updateMany,
      },
    };
    const service = new CampaignsService({} as never, {} as never, {} as never);

    await (
      service as unknown as {
        recalculateCounters(client: unknown, campaignId: string): Promise<void>;
      }
    ).recalculateCounters(tx, 'campaign-1');

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'campaign-1', status: 'RUNNING' },
      data: expect.objectContaining({ status: 'COMPLETED' }) as unknown,
    });
  });
});
