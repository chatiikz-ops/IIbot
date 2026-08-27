/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
const createMock = jest.fn();
jest.mock('@wppconnect-team/wppconnect', () => ({
  create: (...args: unknown[]) => createMock(...args),
  AckType: { FAILED: -1, SENT: 1, RECEIVED: 2, READ: 3 },
  SocketState: {
    CONNECTED: 'CONNECTED',
    PAIRING: 'PAIRING',
    CONFLICT: 'CONFLICT',
    TIMEOUT: 'TIMEOUT',
    UNLAUNCHED: 'UNLAUNCHED',
  },
}));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { WppConnectTransport } from './wppconnect.transport';

describe('WppConnectTransport', () => {
  const handlers: Record<string, (value: never) => void> = {};
  const client = {
    close: jest.fn().mockResolvedValue(true),
    logout: jest.fn().mockResolvedValue(true),
    isConnected: jest.fn().mockResolvedValue(true),
    getHostDevice: jest.fn().mockResolvedValue({
      wid: { user: '10000000000' },
      pushname: 'Test account',
    }),
    getPnLidEntry: jest.fn().mockResolvedValue({
      phoneNumber: { _serialized: '123@c.us' },
    }),
    checkNumberStatus: jest.fn().mockResolvedValue({ canReceiveMessage: true }),
    sendText: jest.fn().mockResolvedValue({
      id: 'true_123@c.us_PROVIDER',
      fromMe: true,
      from: 'owner@c.us',
      to: '123@c.us',
      body: 'test',
      t: 100,
    }),
    downloadMedia: jest.fn(),
    onMessage: jest.fn((handler) => {
      handlers.message = handler;
    }),
    onAck: jest.fn((handler) => {
      handlers.ack = handler;
    }),
    onStateChange: jest.fn((handler) => {
      handlers.state = handler;
    }),
  };
  const session = {
    status: 'IDLE',
    phoneNumber: null,
    displayName: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastError: null,
  };
  const prisma = {
    whatsAppSession: {
      findUnique: jest.fn().mockResolvedValue(session),
      upsert: jest.fn().mockResolvedValue(session),
    },
  };
  const config = {
    transport: 'wppconnect',
    enabled: true,
    clientId: 'test-session',
    wppConnectSessionPath: 'storage/wppconnect-test',
    headless: true,
    browserLaunchOptions: { headless: true, args: ['--disable-dev-shm-usage'] },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    createMock.mockResolvedValue(client);
  });

  it('handles QR and becomes CONNECTED using the same generation', async () => {
    createMock.mockImplementation(async (options) => {
      await options.catchQR('safe-qr-value');
      return client;
    });
    const transport = new WppConnectTransport(prisma as never, config as never);
    await transport.initialize();
    expect((await transport.getStatus()).state).toBe('CONNECTED');
    expect(transport.getQr()).toEqual(
      expect.objectContaining({ available: false }),
    );
  });

  it('restores a persisted session without requiring QR', async () => {
    const transport = new WppConnectTransport(prisma as never, config as never);
    await transport.initialize();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect((await transport.getStatus()).connected).toBe(true);
  });

  it('returns a real provider ID from sendText', async () => {
    const transport = new WppConnectTransport(prisma as never, config as never);
    await transport.initialize();
    const result = await transport.sendText('123@c.us', 'test');
    expect(result?.id._serialized).toBe('true_123@c.us_PROVIDER');
  });

  it('normalizes inbound and ACK events and ignores stale generations', async () => {
    const transport = new WppConnectTransport(prisma as never, config as never);
    const inbound = jest.fn().mockResolvedValue(undefined);
    const ack = jest.fn().mockResolvedValue(undefined);
    transport.onMessage(inbound);
    transport.onAck(ack);
    await transport.initialize();
    handlers.message({
      id: 'inbound-id',
      from: '123@c.us',
      fromMe: false,
    } as never);
    handlers.ack({
      id: { _serialized: 'ack-id', fromMe: true },
      ack: -1,
    } as never);
    await Promise.resolve();
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(expect.anything(), -1, 1);
  });

  it('supports disconnect, reconnect and logout as bounded single-client operations', async () => {
    const transport = new WppConnectTransport(prisma as never, config as never);
    await transport.initialize();
    await transport.disconnect();
    expect(client.close).toHaveBeenCalled();
    await transport.reconnect();
    await transport.logout();
    expect(client.logout).toHaveBeenCalled();
  });

  it('propagates failed sends without synthesizing an ID', async () => {
    client.sendText.mockRejectedValueOnce(new Error('provider rejected'));
    const transport = new WppConnectTransport(prisma as never, config as never);
    await transport.initialize();
    await expect(transport.sendText('123@c.us', 'test')).rejects.toThrow(
      'provider rejected',
    );
  });
});
