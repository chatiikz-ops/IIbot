import { MessageAck } from 'whatsapp-web.js';
import { WhatsAppMessageStatus } from '../generated/prisma/enums';
import { WhatsAppClientService } from './whatsapp-client.service';
import { WhatsAppMessagingService } from './whatsapp-messaging.service';

jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../generated/prisma/client', () => ({ Prisma: {} }));
jest.mock('../media/media-processing.service', () => ({
  MediaProcessingService: class {},
}));

describe('WhatsAppMessagingService acknowledgements', () => {
  type UpdateManyArgs = {
    where: {
      externalMessageId: string;
      status: { in: WhatsAppMessageStatus[] };
    };
    data: { status: WhatsAppMessageStatus; errorMessage?: string };
  };
  const updateMany = jest.fn<
    (args: UpdateManyArgs) => Promise<{ count: number }>
  >(() => Promise.resolve({ count: 1 }));
  const client = { onMessage: jest.fn(), onAck: jest.fn() };
  const service = new WhatsAppMessagingService(
    { whatsAppMessage: { updateMany } } as never,
    client as never,
    {} as never,
  );
  const message = { id: { _serialized: 'external-message-id' } } as never;

  beforeEach(() => updateMany.mockClear());

  it.each([
    [
      MessageAck.ACK_SERVER,
      WhatsAppMessageStatus.SENT,
      [WhatsAppMessageStatus.PENDING, WhatsAppMessageStatus.OUTCOME_UNKNOWN],
    ],
    [
      MessageAck.ACK_DEVICE,
      WhatsAppMessageStatus.DELIVERED,
      [
        WhatsAppMessageStatus.PENDING,
        WhatsAppMessageStatus.OUTCOME_UNKNOWN,
        WhatsAppMessageStatus.SENT,
      ],
    ],
    [
      MessageAck.ACK_READ,
      WhatsAppMessageStatus.READ,
      [
        WhatsAppMessageStatus.PENDING,
        WhatsAppMessageStatus.OUTCOME_UNKNOWN,
        WhatsAppMessageStatus.SENT,
        WhatsAppMessageStatus.DELIVERED,
      ],
    ],
    [
      MessageAck.ACK_PLAYED,
      WhatsAppMessageStatus.READ,
      [
        WhatsAppMessageStatus.PENDING,
        WhatsAppMessageStatus.OUTCOME_UNKNOWN,
        WhatsAppMessageStatus.SENT,
        WhatsAppMessageStatus.DELIVERED,
      ],
    ],
    [
      MessageAck.ACK_ERROR,
      WhatsAppMessageStatus.FAILED,
      [
        WhatsAppMessageStatus.PENDING,
        WhatsAppMessageStatus.OUTCOME_UNKNOWN,
        WhatsAppMessageStatus.SENT,
      ],
    ],
  ])('maps ACK %s monotonically to %s', async (ack, status, eligible) => {
    await service.handleAck(message, ack);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        externalMessageId: 'external-message-id',
        status: { in: eligible },
      },
      data:
        status === WhatsAppMessageStatus.FAILED
          ? { status, errorMessage: 'WhatsApp delivery failed' }
          : { status },
    });
  });

  it('ignores ACK_PENDING without touching persistence', async () => {
    await service.handleAck(message, MessageAck.ACK_PENDING);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('WhatsAppClientService ACK mapping', () => {
  it('extracts a serialized provider message ID', () => {
    expect(
      WhatsAppClientService.externalMessageIdentity({
        id: { _serialized: 'true_77001234567@c.us_PROVIDER' },
      } as never),
    ).toEqual({
      value: 'true_77001234567@c.us_PROVIDER',
      source: 'SERIALIZED',
    });
  });

  it('extracts the WhatsApp Web 2.3000.x $1 serialized ID fallback', () => {
    expect(
      WhatsAppClientService.externalMessageIdentity({
        id: { $1: 'true_77001234567@c.us_PROVIDER_NEW' },
      } as never),
    ).toEqual({
      value: 'true_77001234567@c.us_PROVIDER_NEW',
      source: 'SERIALIZED',
    });
  });

  it('builds a stable provider ID from inner ID parts', () => {
    expect(
      WhatsAppClientService.externalMessageIdentity({
        id: {
          id: 'INNER',
          remote: '77001234567@c.us',
          fromMe: true,
        },
      } as never),
    ).toEqual({
      value: 'wwebjs:77001234567@c.us:1:INNER',
      source: 'MESSAGE_ID_PARTS',
    });
  });

  it('classifies a missing provider result as a fallback identity', () => {
    expect(
      WhatsAppClientService.externalMessageIdentity(undefined),
    ).toMatchObject({ source: 'FALLBACK_ID' });
  });

  it.each([
    [MessageAck.ACK_ERROR, WhatsAppMessageStatus.FAILED],
    [MessageAck.ACK_PENDING, null],
    [MessageAck.ACK_SERVER, WhatsAppMessageStatus.SENT],
    [MessageAck.ACK_DEVICE, WhatsAppMessageStatus.DELIVERED],
    [MessageAck.ACK_READ, WhatsAppMessageStatus.READ],
    [MessageAck.ACK_PLAYED, WhatsAppMessageStatus.READ],
  ])('maps real whatsapp-web.js ACK %s to %s', (ack, status) => {
    expect(WhatsAppClientService.ackStatus(ack)).toBe(status);
  });
});

describe('WhatsApp cold outbound ACK circuit', () => {
  const createCircuitService = () => {
    const events: string[] = [];
    const campaignUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      whatsAppMessage: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({
          conversationId: 'campaign-conversation',
        }),
      },
      campaignTarget: {
        findUnique: jest.fn().mockResolvedValue({ campaignId: 'campaign-1' }),
      },
      campaignLog: {
        create: jest.fn(({ data }: { data: { event: string } }) => {
          events.unshift(data.event);
          return Promise.resolve({});
        }),
        findMany: jest.fn(() =>
          Promise.resolve(events.slice(0, 3).map((event) => ({ event }))),
        ),
      },
      campaign: { updateMany: campaignUpdateMany },
    };
    return {
      service: new WhatsAppMessagingService(
        prisma as never,
        { onMessage: jest.fn(), onAck: jest.fn() } as never,
        {} as never,
      ),
      events,
      campaignUpdateMany,
    };
  };

  const coldMessage = (id: string) =>
    ({
      id: { _serialized: id },
      fromMe: true,
      to: '77086810693@c.us',
    }) as never;

  it('pauses the affected campaign after three consecutive ACK_ERROR events', async () => {
    const { service, campaignUpdateMany } = createCircuitService();
    await service.handleAck(coldMessage('cold-1'), MessageAck.ACK_ERROR, 1);
    await service.handleAck(coldMessage('cold-2'), MessageAck.ACK_ERROR, 1);
    await service.handleAck(coldMessage('cold-3'), MessageAck.ACK_ERROR, 1);
    expect(campaignUpdateMany).toHaveBeenCalledWith({
      where: { id: 'campaign-1', status: 'RUNNING' },
      data: { status: 'PAUSED' },
    });
  });

  it('ACK_SERVER resets the consecutive ACK_ERROR sequence', async () => {
    const { service, events, campaignUpdateMany } = createCircuitService();
    await service.handleAck(coldMessage('cold-1'), MessageAck.ACK_ERROR, 1);
    await service.handleAck(coldMessage('cold-2'), MessageAck.ACK_ERROR, 1);
    await service.handleAck(coldMessage('cold-ok'), MessageAck.ACK_SERVER, 1);
    await service.handleAck(coldMessage('cold-3'), MessageAck.ACK_ERROR, 1);
    expect(events).toContain('WHATSAPP_COLD_ACK_SUCCESS');
    expect(campaignUpdateMany).not.toHaveBeenCalled();
  });
});

describe('WhatsAppMessagingService late ACK reconciliation', () => {
  it.each([
    [MessageAck.ACK_SERVER, WhatsAppMessageStatus.SENT],
    [MessageAck.ACK_DEVICE, WhatsAppMessageStatus.DELIVERED],
    [MessageAck.ACK_READ, WhatsAppMessageStatus.READ],
  ])('promotes OUTCOME_UNKNOWN on late ACK %s', async (ack, status) => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      whatsAppMessage: {
        updateMany,
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'wa-unknown',
            externalMessageId: null,
            status: WhatsAppMessageStatus.OUTCOME_UNKNOWN,
            sentAt: null,
          },
        ]),
      },
    };
    const service = new WhatsAppMessagingService(
      prisma as never,
      { onMessage: jest.fn(), onAck: jest.fn() } as never,
      {} as never,
    );
    await service.handleAck(
      {
        id: { _serialized: 'provider-id' },
        to: '77086810693@c.us',
        body: 'Saved reply',
      } as never,
      ack,
    );
    expect(updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'wa-unknown',
        externalMessageId: null,
        // Jest's asymmetric matcher is intentionally dynamic here.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        status: { in: expect.any(Array) },
      },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        externalMessageId: 'provider-id',
        status,
        errorMessage: null,
      }),
    });
  });
});

describe('WhatsAppMessagingService outbound idempotency', () => {
  it('marks SENT only when sendMessage returns a real provider ID', async () => {
    let stored = {
      id: 'wa-real-id',
      messageId: 'ai-real-id',
      status: WhatsAppMessageStatus.PENDING,
      externalMessageId: null as string | null,
      sentAt: null as Date | null,
      errorMessage: null as string | null,
    };
    const prisma = {
      whatsAppMessage: {
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn(() => Promise.resolve(stored)),
        create: jest.fn(() => Promise.resolve(stored)),
        updateMany: jest.fn(({ data }: { data: Partial<typeof stored> }) => {
          stored = { ...stored, ...data };
          return Promise.resolve({ count: 1 });
        }),
      },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'ai-real-id' }) },
      contact: { findFirst: jest.fn().mockResolvedValue({ id: 'contact-1' }) },
    };
    const client = {
      onMessage: jest.fn(),
      onAck: jest.fn(),
      getGeneration: jest.fn(() => 4),
      isRegisteredUser: jest.fn().mockResolvedValue(true),
      sendText: jest.fn().mockResolvedValue({
        id: { _serialized: 'true_77086810693@c.us_REAL' },
      }),
    };
    const service = new WhatsAppMessagingService(
      prisma as never,
      client as never,
      {} as never,
    );

    await expect(
      service.sendAiMessage({
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        messageId: 'ai-real-id',
        phone: '+77086810693',
        text: 'Confirmed directly',
      }),
    ).resolves.toMatchObject({
      outcomePending: false,
      whatsappMessage: {
        status: WhatsAppMessageStatus.SENT,
        externalMessageId: 'true_77086810693@c.us_REAL',
      },
    });
  });

  it('calls transport once when provider throws after a possible send', async () => {
    const outbound = {
      id: 'wa-outbound-unknown',
      messageId: 'ai-message-unknown',
      status: WhatsAppMessageStatus.PENDING,
      externalMessageId: null,
      errorMessage: null,
    };
    let stored: typeof outbound | null = null;
    const prisma = {
      whatsAppMessage: {
        findUnique: jest.fn(() => Promise.resolve(stored)),
        findUniqueOrThrow: jest.fn(() => Promise.resolve(stored)),
        create: jest.fn(() => {
          stored = { ...outbound };
          return Promise.resolve(stored);
        }),
        updateMany: jest.fn(({ data }: { data: Partial<typeof outbound> }) => {
          stored = { ...stored!, ...data };
          return Promise.resolve({ count: 1 });
        }),
      },
      message: {
        findFirst: jest.fn(() => Promise.resolve({ id: outbound.messageId })),
      },
      contact: {
        findFirst: jest.fn(() => Promise.resolve({ id: 'contact-1' })),
      },
    };
    const client = {
      onMessage: jest.fn(),
      onAck: jest.fn(),
      isRegisteredUser: jest.fn(() => Promise.resolve(true)),
      sendText: jest.fn(() =>
        Promise.reject(new TypeError('provider post-send failure')),
      ),
    };
    const service = new WhatsAppMessagingService(
      prisma as never,
      client as never,
      {} as never,
    );
    const input = {
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      messageId: outbound.messageId,
      phone: '+77086810693',
      text: 'Saved reply',
    };

    await expect(service.sendAiMessage(input)).resolves.toMatchObject({
      alreadySent: false,
      outcomePending: true,
      whatsappMessage: { status: WhatsAppMessageStatus.OUTCOME_UNKNOWN },
    });
    await expect(service.sendAiMessage(input)).resolves.toMatchObject({
      alreadySent: true,
      whatsappMessage: { status: WhatsAppMessageStatus.OUTCOME_UNKNOWN },
    });
    await expect(service.sendAiMessage(input)).resolves.toMatchObject({
      alreadySent: true,
    });

    expect(client.sendText).toHaveBeenCalledTimes(1);
    expect(stored?.errorMessage).toContain('provider post-send failure');
  });

  it('marks a provider result without an ID as OUTCOME_UNKNOWN', async () => {
    const outbound = {
      id: 'wa-no-id',
      messageId: 'ai-no-id',
      status: WhatsAppMessageStatus.PENDING,
      externalMessageId: null,
      errorMessage: null as string | null,
    };
    let stored = { ...outbound };
    const prisma = {
      whatsAppMessage: {
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn(() => Promise.resolve(stored)),
        create: jest.fn(() => Promise.resolve(stored)),
        updateMany: jest.fn(({ data }: { data: Partial<typeof stored> }) => {
          stored = { ...stored, ...data };
          return Promise.resolve({ count: 1 });
        }),
      },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'ai-no-id' }) },
      contact: { findFirst: jest.fn().mockResolvedValue({ id: 'contact-1' }) },
    };
    const client = {
      onMessage: jest.fn(),
      onAck: jest.fn(),
      isRegisteredUser: jest.fn().mockResolvedValue(true),
      sendText: jest.fn().mockResolvedValue(undefined),
    };
    const service = new WhatsAppMessagingService(
      prisma as never,
      client as never,
      {} as never,
    );

    await expect(
      service.sendAiMessage({
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        messageId: 'ai-no-id',
        phone: '+77086810693',
        text: 'Diagnostic',
      }),
    ).resolves.toMatchObject({
      outcomePending: true,
      whatsappMessage: { status: WhatsAppMessageStatus.OUTCOME_UNKNOWN },
    });
    expect(stored.errorMessage).toContain('returned no message ID');
    expect(stored.externalMessageId).toBeNull();
  });

  it('uses message_create to confirm an undefined sendMessage result', async () => {
    const outbound = {
      id: 'wa-message-create',
      messageId: 'ai-message-create',
      status: WhatsAppMessageStatus.PENDING,
      externalMessageId: null as string | null,
      sentAt: null as Date | null,
      errorMessage: null as string | null,
    };
    let stored = { ...outbound };
    let messageCreateHandler:
      ((message: unknown, generation: number) => Promise<void>) | undefined;
    const prisma = {
      whatsAppMessage: {
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn(() => Promise.resolve(stored)),
        create: jest.fn(() => Promise.resolve(stored)),
        updateMany: jest.fn(
          ({
            where,
            data,
          }: {
            where: { status?: { in: WhatsAppMessageStatus[] } };
            data: Partial<typeof stored>;
          }) => {
            if (!where.status || where.status.in.includes(stored.status)) {
              stored = { ...stored, ...data };
              return Promise.resolve({ count: 1 });
            }
            return Promise.resolve({ count: 0 });
          },
        ),
      },
      message: {
        findFirst: jest.fn().mockResolvedValue({ id: 'ai-message-create' }),
      },
      contact: { findFirst: jest.fn().mockResolvedValue({ id: 'contact-1' }) },
    };
    const client = {
      onMessage: jest.fn(),
      onAck: jest.fn(),
      onMessageCreate: jest.fn(
        (handler: (message: unknown, generation: number) => Promise<void>) => {
          messageCreateHandler = handler;
        },
      ),
      getGeneration: jest.fn(() => 7),
      isRegisteredUser: jest.fn().mockResolvedValue(true),
      sendText: jest.fn(async () => {
        await messageCreateHandler?.(
          {
            id: {
              _serialized: 'true_53296299557012@lid_PROVIDER',
              remote: '53296299557012@lid',
              fromMe: true,
            },
            fromMe: true,
            to: '53296299557012@lid',
            body: 'Confirmed by event',
            timestamp: Math.floor(Date.now() / 1000),
          },
          7,
        );
        return undefined;
      }),
    };
    const service = new WhatsAppMessagingService(
      prisma as never,
      client as never,
      {} as never,
    );

    await expect(
      service.sendAiMessage({
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        messageId: 'ai-message-create',
        phone: '+77086810693',
        text: 'Confirmed by event',
      }),
    ).resolves.toMatchObject({
      outcomePending: false,
      whatsappMessage: {
        status: WhatsAppMessageStatus.SENT,
        externalMessageId: 'true_53296299557012@lid_PROVIDER',
      },
    });
  });

  it('correlates ACK_ERROR to a fallback row and replaces it with provider ID', async () => {
    const fallback = {
      id: 'wa-fallback',
      externalMessageId: 'fallback:sha256:legacy',
      status: WhatsAppMessageStatus.SENT,
      sentAt: new Date(),
    };
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      whatsAppMessage: {
        updateMany,
        findMany: jest.fn().mockResolvedValue([fallback]),
      },
    };
    const service = new WhatsAppMessagingService(
      prisma as never,
      { onMessage: jest.fn(), onAck: jest.fn() } as never,
      {} as never,
    );

    await service.handleAck(
      {
        id: {
          _serialized: 'true_53296299557012@lid_REAL',
          remote: '53296299557012@lid',
          fromMe: true,
        },
        fromMe: true,
        to: '53296299557012@lid',
        body: 'Legacy fallback',
      } as never,
      MessageAck.ACK_ERROR,
      9,
    );

    expect(updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'wa-fallback',
        externalMessageId: 'fallback:sha256:legacy',
        status: {
          in: [
            WhatsAppMessageStatus.PENDING,
            WhatsAppMessageStatus.OUTCOME_UNKNOWN,
            WhatsAppMessageStatus.SENT,
          ],
        },
      },
      data: {
        externalMessageId: 'true_53296299557012@lid_REAL',
        status: WhatsAppMessageStatus.FAILED,
        errorMessage: 'WhatsApp provider returned ACK_ERROR',
      },
    });
  });

  it('does not correlate an ACK when multiple pending rows match', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      whatsAppMessage: {
        updateMany,
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'candidate-1' }, { id: 'candidate-2' }]),
      },
    };
    const service = new WhatsAppMessagingService(
      prisma as never,
      { onMessage: jest.fn(), onAck: jest.fn() } as never,
      {} as never,
    );

    await service.handleAck(
      {
        id: { _serialized: 'another-provider-id' },
        fromMe: true,
        to: '77086810693@c.us',
        body: 'Same body',
      } as never,
      MessageAck.ACK_SERVER,
    );
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('does not call the transport again for an already SENT AI message', async () => {
    const existing = {
      id: 'wa-outbound-1',
      messageId: 'ai-message-1',
      status: WhatsAppMessageStatus.SENT,
      externalMessageId: 'provider-message-1',
    };
    const prisma = {
      whatsAppMessage: {
        findUnique: jest.fn(() => Promise.resolve(existing)),
      },
    };
    const client = {
      onMessage: jest.fn(),
      onAck: jest.fn(),
      sendText: jest.fn(),
    };
    const service = new WhatsAppMessagingService(
      prisma as never,
      client as never,
      {} as never,
    );

    await expect(
      service.sendAiMessage({
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        messageId: 'ai-message-1',
        phone: '+77086810693',
        text: 'Saved reply',
      }),
    ).resolves.toMatchObject({ alreadySent: true });
    expect(client.sendText).not.toHaveBeenCalled();
  });
});
