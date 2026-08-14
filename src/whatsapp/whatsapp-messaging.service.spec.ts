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
      [
        WhatsAppMessageStatus.PENDING,
        WhatsAppMessageStatus.OUTCOME_UNKNOWN,
        WhatsAppMessageStatus.FAILED,
      ],
    ],
    [
      MessageAck.ACK_DEVICE,
      WhatsAppMessageStatus.DELIVERED,
      [
        WhatsAppMessageStatus.PENDING,
        WhatsAppMessageStatus.OUTCOME_UNKNOWN,
        WhatsAppMessageStatus.FAILED,
        WhatsAppMessageStatus.SENT,
      ],
    ],
    [
      MessageAck.ACK_READ,
      WhatsAppMessageStatus.READ,
      [
        WhatsAppMessageStatus.PENDING,
        WhatsAppMessageStatus.OUTCOME_UNKNOWN,
        WhatsAppMessageStatus.FAILED,
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
        WhatsAppMessageStatus.FAILED,
        WhatsAppMessageStatus.SENT,
        WhatsAppMessageStatus.DELIVERED,
      ],
    ],
    [
      MessageAck.ACK_ERROR,
      WhatsAppMessageStatus.FAILED,
      [WhatsAppMessageStatus.PENDING],
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

describe('WhatsAppMessagingService outbound idempotency', () => {
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

    await expect(service.sendAiMessage(input)).rejects.toThrow();
    await expect(service.sendAiMessage(input)).resolves.toMatchObject({
      alreadySent: true,
      whatsappMessage: { status: WhatsAppMessageStatus.OUTCOME_UNKNOWN },
    });
    await expect(service.sendAiMessage(input)).resolves.toMatchObject({
      alreadySent: true,
    });

    expect(client.sendText).toHaveBeenCalledTimes(1);
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
