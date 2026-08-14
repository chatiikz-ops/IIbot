import { MessageTypes, type Message as WebMessage } from 'whatsapp-web.js';
import { Prisma } from '../generated/prisma/client';
import { WhatsAppMessagingService } from './whatsapp-messaging.service';

jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;

      constructor(message: string, options: { code: string }) {
        super(message);
        this.code = options.code;
      }
    },
  },
}));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../media/media-processing.service', () => ({
  MediaProcessingService: class {},
}));

describe('WhatsApp inbound pipeline', () => {
  const contact = {
    id: 'contact-1',
    phone: '+77086810693',
    strategyCode: 'BARBERSHOP_GENERAL',
  };
  const conversation = {
    id: 'campaign-conversation-1',
    contactId: contact.id,
    strategyCode: contact.strategyCode,
    status: 'WAITING_CLIENT',
  };
  const localMessages: Array<Record<string, unknown>> = [];
  const whatsAppMessages: Array<Record<string, unknown>> = [];
  const conversationUpdate = jest.fn(() => Promise.resolve(conversation));
  const knownInbound = jest.fn(() => Promise.resolve());
  const onMessage = jest.fn();

  const tx = {
    contact: {
      findFirst: jest.fn(() => Promise.resolve(contact)),
    },
    conversation: {
      findFirst: jest.fn(() => Promise.resolve(conversation)),
      create: jest.fn(),
      update: conversationUpdate,
    },
    message: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `message-${localMessages.length + 1}`,
          createdAt: new Date('2026-08-13T14:00:00Z'),
          ...data,
        };
        localMessages.push(row);
        return Promise.resolve(row);
      }),
    },
    whatsAppMessage: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        if (
          whatsAppMessages.some(
            (row) => row.externalMessageId === data.externalMessageId,
          )
        ) {
          throw new Prisma.PrismaClientKnownRequestError('duplicate', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const row = {
          id: `wa-${whatsAppMessages.length + 1}`,
          ...data,
        };
        whatsAppMessages.push(row);
        return Promise.resolve(row);
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => {
      const messageCount = localMessages.length;
      try {
        return await callback(tx);
      } catch (error) {
        localMessages.splice(messageCount);
        throw error;
      }
    }),
  };
  const resolveLidIdentity = jest.fn(
    (
      lid: string,
    ): Promise<{
      lid: string;
      chatId: string;
      source: 'PROVIDER' | 'CACHE';
    } | null> => {
      void lid;
      return Promise.resolve(null);
    },
  );
  const client = {
    onMessage,
    onAck: jest.fn(),
    resolveLidIdentity,
  };
  const service = new WhatsAppMessagingService(
    prisma as never,
    client as never,
    {} as never,
  );

  const inbound = (overrides: Partial<WebMessage> = {}) =>
    ({
      id: { _serialized: 'inbound-1' },
      from: '77086810693@c.us',
      to: '77085139728@c.us',
      fromMe: false,
      isStatus: false,
      broadcast: false,
      hasMedia: false,
      type: MessageTypes.TEXT,
      body: 'да конечно',
      timestamp: 1786630000,
      ...overrides,
    }) as WebMessage;

  beforeAll(() => service.onKnownInbound(knownInbound));
  beforeEach(() => {
    localMessages.length = 0;
    whatsAppMessages.length = 0;
    jest.clearAllMocks();
    resolveLidIdentity.mockResolvedValue(null);
  });

  it('stores a normal known-contact inbound as a CLIENT message', async () => {
    await service.handleInbound(inbound());

    expect(localMessages).toMatchObject([
      {
        conversationId: conversation.id,
        role: 'CLIENT',
        text: 'да конечно',
      },
    ]);
    expect(whatsAppMessages[0]).toMatchObject({
      direction: 'INBOUND',
      status: 'RECEIVED',
      contactId: contact.id,
      conversationId: conversation.id,
      messageId: 'message-1',
    });
    expect(knownInbound).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate a CLIENT message for a duplicate external event', async () => {
    await service.handleInbound(inbound());
    await service.handleInbound(inbound());
    await service.handleInbound(inbound());

    expect(localMessages).toHaveLength(1);
    expect(whatsAppMessages).toHaveLength(1);
    expect(knownInbound).toHaveBeenCalledTimes(1);
  });

  it('reuses the existing Campaign conversation', async () => {
    await service.handleInbound(inbound());

    expect(tx.conversation.create).not.toHaveBeenCalled();
    expect(localMessages[0]?.conversationId).toBe(conversation.id);
  });

  it('ignores own outbound messages', async () => {
    await service.handleInbound(inbound({ fromMe: true }));

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('documents self-chat as ignored while accepting a real @lid sender', async () => {
    await service.handleInbound(
      inbound({ from: '123456789@lid', fromMe: true }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();

    await service.handleInbound(
      inbound({
        id: { _serialized: 'lid-inbound' } as never,
        from: '123456789@lid',
        getContact: () =>
          Promise.resolve({
            id: { _serialized: '77086810693@c.us' },
            number: '77086810693',
            isMyContact: false,
            getFormattedNumber: () => Promise.resolve('+7 708 681 06 93'),
            getCountryCode: () => Promise.resolve('7'),
          }) as never,
      }),
    );
    expect(localMessages).toHaveLength(1);
  });

  it('@lid with a valid serialized ID is stored with the provider ID', async () => {
    await service.handleInbound(
      inbound({
        id: {
          _serialized: 'false_53296299557012@lid_PROVIDER1',
          id: 'PROVIDER1',
          remote: '53296299557012@lid',
          fromMe: false,
        },
        from: '53296299557012@lid',
        getContact: () =>
          Promise.resolve({
            id: { _serialized: '77086810693@c.us' },
            number: '53296299557012',
            isMyContact: false,
            getFormattedNumber: () => Promise.resolve('+7 708 681 06 93'),
            getCountryCode: () => Promise.resolve('7'),
          }) as never,
      }),
    );

    expect(whatsAppMessages[0]?.externalMessageId).toBe(
      'false_53296299557012@lid_PROVIDER1',
    );
    expect(whatsAppMessages[0]?.phone).toBe('+77086810693');
  });

  it('resolves @lid through the linked provider c.us identity', async () => {
    resolveLidIdentity.mockResolvedValue({
      lid: '53296299557012@lid',
      chatId: '77086810693@c.us',
      source: 'PROVIDER',
    });
    const getContact = jest.fn(() => Promise.reject(new Error('not needed')));

    await service.handleInbound(
      inbound({
        id: { _serialized: 'provider-linked-id' } as never,
        from: '53296299557012@lid',
        getContact,
      }),
    );

    expect(whatsAppMessages[0]?.phone).toBe('+77086810693');
    expect(getContact).not.toHaveBeenCalled();
  });

  it('never treats Contact.number containing a LID as a phone', async () => {
    await service.handleInbound(
      inbound({
        id: { _serialized: 'unresolved-lid-id' } as never,
        from: '53296299557012@lid',
        getContact: () =>
          Promise.resolve({
            id: { _serialized: '53296299557012@lid' },
            number: '53296299557012',
            isMyContact: false,
            getFormattedNumber: () => Promise.resolve(null),
            getCountryCode: () => Promise.resolve(null),
          }) as never,
      }),
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('builds a stable provider identity when _serialized is missing', async () => {
    const malformed = inbound({
      id: {
        _serialized: undefined,
        id: 'INNER_PROVIDER_ID',
        remote: '53296299557012@lid',
        fromMe: false,
      } as never,
      from: '53296299557012@lid',
      getContact: () =>
        Promise.resolve({
          id: { _serialized: '77086810693@c.us' },
          number: '53296299557012',
          isMyContact: false,
          getFormattedNumber: () => Promise.resolve('+7 708 681 06 93'),
          getCountryCode: () => Promise.resolve('7'),
        }) as never,
    });

    await service.handleInbound(malformed);

    expect(whatsAppMessages[0]?.externalMessageId).toBe(
      'wwebjs:53296299557012@lid:0:INNER_PROVIDER_ID',
    );
  });

  it('uses a deterministic fallback and does not silently lose an ID-less event', async () => {
    const malformed = inbound({
      id: undefined as never,
      from: '53296299557012@lid',
      getContact: () =>
        Promise.resolve({
          id: { _serialized: '77086810693@c.us' },
          number: '53296299557012',
          isMyContact: false,
          getFormattedNumber: () => Promise.resolve('+7 708 681 06 93'),
          getCountryCode: () => Promise.resolve('7'),
        }) as never,
    });

    await service.handleInbound(malformed);
    await service.handleInbound(malformed);

    expect(whatsAppMessages).toHaveLength(1);
    expect(localMessages).toHaveLength(1);
    expect(whatsAppMessages[0]?.externalMessageId).toMatch(
      /^fallback:sha256:[a-f0-9]{64}$/,
    );
    expect(knownInbound).toHaveBeenCalledTimes(1);
  });
});
