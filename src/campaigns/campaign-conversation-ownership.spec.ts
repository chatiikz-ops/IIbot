import { CampaignsService } from './campaigns.service';

jest.mock('../generated/prisma/client', () => ({ Prisma: {} }));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

describe('Campaign conversation ownership', () => {
  it('creates a distinct conversation when the proposed one belongs to an older campaign target', async () => {
    const conversations = new Map([
      [
        'conversation-a',
        {
          id: 'conversation-a',
          contactId: 'contact-1',
          strategyCode: 'BEAUTY',
          messages: [{ id: 'history-a' }],
        },
      ],
    ]);
    const targets = new Map([
      [
        'target-a',
        {
          id: 'target-a',
          campaignId: 'campaign-a',
          contactId: 'contact-1',
          strategyCode: 'BEAUTY',
          conversationId: 'conversation-a',
        },
      ],
      [
        'target-b',
        {
          id: 'target-b',
          campaignId: 'campaign-b',
          contactId: 'contact-1',
          strategyCode: 'BEAUTY',
          conversationId: null,
        },
      ],
    ]);
    let sequence = 1;
    const tx = {
      $executeRaw: jest.fn(() => Promise.resolve(1)),
      campaignTarget: {
        findUnique: jest.fn(
          (query: {
            where: { id?: string; conversationId?: string };
            include?: { conversation?: boolean };
          }) => {
            const target = query.where.id
              ? targets.get(query.where.id)
              : [...targets.values()].find(
                  (item) => item.conversationId === query.where.conversationId,
                );
            if (!target) return Promise.resolve(null);
            return Promise.resolve({
              ...target,
              ...(query.include?.conversation
                ? {
                    conversation: target.conversationId
                      ? conversations.get(target.conversationId)
                      : null,
                  }
                : {}),
            });
          },
        ),
        update: jest.fn(
          (query: {
            where: { id: string };
            data: { conversationId: string };
          }) => {
            const target = targets.get(query.where.id)!;
            target.conversationId = query.data.conversationId;
            return Promise.resolve(target);
          },
        ),
      },
      conversation: {
        findUnique: jest.fn((query: { where: { id: string } }) =>
          Promise.resolve(conversations.get(query.where.id) ?? null),
        ),
        create: jest.fn(
          (query: {
            data: { contactId: string; strategyCode: string | null };
          }) => {
            const conversation = {
              id: `conversation-b-${sequence++}`,
              contactId: query.data.contactId,
              strategyCode: query.data.strategyCode ?? 'MANUAL_WHATSAPP',
              messages: [],
            };
            conversations.set(conversation.id, conversation);
            return Promise.resolve(conversation);
          },
        ),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      ),
    };
    const service = new CampaignsService(
      prisma as never,
      {} as never,
      {} as never,
    );

    const attached = await service.attachConversation(
      'target-b',
      'conversation-a',
    );

    expect(attached.id).not.toBe('conversation-a');
    expect(targets.get('target-b')?.conversationId).toBe(attached.id);
    expect(targets.get('target-a')?.conversationId).toBe('conversation-a');
    expect(conversations.get('conversation-a')?.messages).toEqual([
      { id: 'history-a' },
    ]);
    expect(
      [...targets.values()].filter(
        (target) => target.conversationId === 'conversation-a',
      ),
    ).toHaveLength(1);
  });
});
