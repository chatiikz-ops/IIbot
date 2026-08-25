import { EventEmitter } from 'node:events';

jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { WhatsAppConnectionStatus } from '../generated/prisma/enums';
import { WhatsAppClientService } from './whatsapp-client.service';

class FakeClient extends EventEmitter {
  initialize = jest.fn<Promise<void>, []>();
  destroy = jest.fn(() => Promise.resolve(undefined));
  logout = jest.fn(() => Promise.resolve(undefined));
  isRegisteredUser = jest.fn(() => Promise.resolve(true));
  sendMessage = jest.fn(() => Promise.resolve({ id: 'sent' }));
  getContactLidAndPhone = jest.fn(() =>
    Promise.resolve([
      {
        lid: '53296299557012@lid',
        pn: '77086810693@c.us',
      },
    ]),
  );
  pupBrowser = {
    isConnected: jest.fn(() => false),
    close: jest.fn(() => Promise.resolve()),
  };
  info = { wid: { user: '77001234567' }, pushname: 'Test' };
}

type Internals = {
  createClient: () => FakeClient;
  lifecycleState: string;
  generation: number;
  withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T>;
};
type UpsertArg = {
  create: Record<string, unknown> & { status: WhatsAppConnectionStatus };
  update: Record<string, unknown> & { status: WhatsAppConnectionStatus };
};

describe('WhatsAppClientService lifecycle', () => {
  let service: WhatsAppClientService;
  let clients: FakeClient[];
  let session: Record<string, unknown>;
  let upsert: jest.Mock<Promise<Record<string, unknown>>, [UpsertArg]>;

  beforeEach(() => {
    clients = [];
    session = { status: WhatsAppConnectionStatus.DISCONNECTED };
    upsert = jest.fn(({ create, update }: UpsertArg) => {
      session = {
        ...session,
        ...(Object.keys(session).length ? update : create),
      };
      return Promise.resolve(session);
    });
    const prisma = {
      whatsAppSession: {
        upsert,
        findUnique: jest.fn(() => Promise.resolve(session)),
      },
    };
    const config = {
      enabled: true,
      clientId: 'test',
      sessionPath: '.test-session',
      initTimeoutMs: 250,
      headless: true,
      chromeExecutablePath: process.execPath,
      qrTtlSeconds: 60,
    };
    service = new WhatsAppClientService(prisma as never, config as never);
    (service as unknown as Internals).createClient = () => {
      const client = new FakeClient();
      client.initialize.mockImplementation(
        () => new Promise<void>(() => undefined),
      );
      clients.push(client);
      return client;
    };
  });

  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const ready = async (client?: FakeClient) => {
    await tick();
    (client ?? clients[0]).emit('ready');
    await tick();
  };
  const waitForQr = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const qr = service.getQr();
      if (qr.available) return qr;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return service.getQr();
  };

  it('coalesces repeated initialize calls into one client', async () => {
    const first = service.initialize();
    const second = service.initialize();
    expect(first).toBe(second);
    await tick();
    expect(clients).toHaveLength(1);
    await ready();
    await Promise.all([first, second]);
  });

  it('keeps initialization pending after QR', async () => {
    const operation = service.initialize();
    let settled = false;
    void operation.then(() => (settled = true));
    await tick();
    clients[0].emit('qr', 'raw-qr');
    const availableQr = await waitForQr();
    expect(settled).toBe(false);
    expect(availableQr).toMatchObject({
      available: true,
      generation: 1,
      lifecycleState: 'INITIALIZING',
    });
    expect((availableQr as { qrDataUrl: string }).qrDataUrl).toMatch(
      /^data:image\/png;base64,/,
    );
    await ready();
  });

  it('returns from AUTH_FAILURE to QR_REQUIRED when a fresh QR arrives', async () => {
    const operation = service.initialize();
    await tick();
    clients[0].emit('auth_failure', 'bad session');
    await tick();
    expect(service.getQr()).toMatchObject({ available: false });
    expect(session.status).toBe(WhatsAppConnectionStatus.AUTH_FAILURE);

    clients[0].emit('qr', 'fresh-qr');
    await waitForQr();
    await expect(service.getStatus()).resolves.toMatchObject({
      status: WhatsAppConnectionStatus.QR_REQUIRED,
      qrAvailable: true,
    });
    await ready();
    await operation;
  });

  it('handles repeated ready idempotently', async () => {
    const operation = service.initialize();
    await ready();
    clients[0].emit('ready');
    await tick();
    await operation;
    const connectedWrites = upsert.mock.calls.filter(
      ([arg]) => arg.update.status === WhatsAppConnectionStatus.CONNECTED,
    );
    expect(connectedWrites).toHaveLength(1);
  });

  it('transitions authenticated -> ready to a fully connected state', async () => {
    const operation = service.initialize();
    await tick();
    clients[0].emit('authenticated');
    await tick();
    await expect(service.getStatus()).resolves.toMatchObject({
      status: WhatsAppConnectionStatus.AUTHENTICATING,
      connected: false,
    });

    await ready();
    await operation;

    await expect(service.getStatus()).resolves.toMatchObject({
      status: WhatsAppConnectionStatus.CONNECTED,
      connected: true,
      lifecycleState: 'READY',
      phoneNumber: '+77001234567',
      displayName: 'Test',
      qrAvailable: false,
      lastError: null,
    });
    expect(session.lastConnectedAt).toBeInstanceOf(Date);
  });

  it('ignores authenticated events that arrive after ready', async () => {
    const operation = service.initialize();
    await ready();
    await operation;
    clients[0].emit('authenticated');
    await tick();

    await expect(service.getStatus()).resolves.toMatchObject({
      status: WhatsAppConnectionStatus.CONNECTED,
      connected: true,
      lifecycleState: 'READY',
    });
    expect(session.status).toBe(WhatsAppConnectionStatus.CONNECTED);
  });

  it('resolves initialization immediately when ready is received', async () => {
    const operation = service.initialize();
    await tick();
    clients[0].emit('authenticated');
    clients[0].emit('ready');

    await expect(
      Promise.race([
        operation.then(() => 'resolved'),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('still-pending'), 50),
        ),
      ]),
    ).resolves.toBe('resolved');
  });

  it('handles repeated disconnected idempotently', async () => {
    const operation = service.initialize();
    await ready();
    await operation;
    clients[0].emit('disconnected', 'NAVIGATION');
    clients[0].emit('disconnected', 'NAVIGATION');
    await tick();
    const writes = upsert.mock.calls.filter(
      ([arg]) => arg.update.status === WhatsAppConnectionStatus.DISCONNECTED,
    );
    expect(writes).toHaveLength(1);
  });

  it('serializes repeated reconnect calls', async () => {
    const initial = service.initialize();
    await ready();
    await initial;
    const one = service.reconnect();
    const two = service.reconnect();
    await tick();
    expect(clients).toHaveLength(2);
    await ready(clients[1]);
    await Promise.all([one, two]);
    expect(clients[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('allows destroy during initialization without leaking the client', async () => {
    const initialization = service.initialize();
    const destruction = service.destroy();
    await Promise.all([initialization, destruction]);
    expect(clients[0].destroy).toHaveBeenCalledTimes(1);
    expect((service as unknown as Internals).lifecycleState).toBe('IDLE');
  });

  it('completes normal destroy quickly and persists DISCONNECTED', async () => {
    const initialization = service.initialize();
    await ready();
    await initialization;
    const startedAt = Date.now();
    await service.destroy();
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(session.status).toBe(WhatsAppConnectionStatus.DISCONNECTED);
    expect(clients[0].logout).not.toHaveBeenCalled();
  });

  it('bounds a client.destroy call that never settles', async () => {
    const initialization = service.initialize();
    await ready();
    await initialization;
    clients[0].destroy.mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    jest.useFakeTimers();
    const destruction = service.destroy();
    await jest.advanceTimersByTimeAsync(4001);
    await destruction;
    jest.useRealTimers();
    expect(session.status).toBe(WhatsAppConnectionStatus.DISCONNECTED);
    expect((service as unknown as Internals).lifecycleState).toBe('IDLE');
  });

  it('bounds forced Chromium close and remains idempotent', async () => {
    const initialization = service.initialize();
    await ready();
    await initialization;
    clients[0].pupBrowser.isConnected.mockReturnValue(true);
    clients[0].pupBrowser.close.mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    jest.useFakeTimers();
    const destruction = service.destroy();
    await jest.advanceTimersByTimeAsync(2501);
    await destruction;
    await service.destroy();
    jest.useRealTimers();
    expect(session.status).toBe(WhatsAppConnectionStatus.DISCONNECTED);
    expect(clients[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('reconnects with preserved LocalAuth after destroy', async () => {
    const initialization = service.initialize();
    await ready();
    await initialization;
    await service.destroy();
    const reconnect = service.reconnect();
    await tick();
    expect(clients).toHaveLength(2);
    await ready(clients[1]);
    await reconnect;
    await expect(service.getStatus()).resolves.toMatchObject({
      connected: true,
      lifecycleState: 'READY',
    });
    expect(clients[0].logout).not.toHaveBeenCalled();
  });

  it('clean shutdown closes Chromium without logging out or deleting LocalAuth', async () => {
    const initialization = service.initialize();
    await ready();
    await initialization;

    await service.onApplicationShutdown();

    expect(clients[0].destroy).toHaveBeenCalledTimes(1);
    expect(clients[0].logout).not.toHaveBeenCalled();
    expect((service as unknown as Internals).lifecycleState).toBe('IDLE');
    expect(session.status).toBe(WhatsAppConnectionStatus.CONNECTED);
  });

  it('a new service generation restores a preserved LocalAuth session to READY', async () => {
    const firstInitialization = service.initialize();
    await ready();
    await firstInitialization;
    await service.onApplicationShutdown();

    const restored = new WhatsAppClientService(
      {
        whatsAppSession: {
          upsert,
          findUnique: jest.fn(() => Promise.resolve(session)),
        },
      } as never,
      {
        enabled: true,
        clientId: 'test',
        sessionPath: '.test-session',
        initTimeoutMs: 250,
        headless: true,
        chromeExecutablePath: process.execPath,
        qrTtlSeconds: 60,
      } as never,
    );
    const restoredClient = new FakeClient();
    restoredClient.initialize.mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    (restored as unknown as Internals).createClient = () => restoredClient;
    const restoredInitialization = restored.initialize();
    await tick();
    restoredClient.emit('ready');
    await restoredInitialization;

    await expect(restored.getStatus()).resolves.toMatchObject({
      status: WhatsAppConnectionStatus.CONNECTED,
      generation: 1,
    });
    await restored.onApplicationShutdown();
  });

  it('moves auth failure to a terminal failed state', async () => {
    const operation = service.initialize();
    await tick();
    clients[0].emit('auth_failure', 'bad session');
    await operation;
    expect(session.status).toBe(WhatsAppConnectionStatus.AUTH_FAILURE);
    expect((service as unknown as Internals).lifecycleState).toBe('FAILED');
  });

  it('contains an initialize rejection and reports ERROR', async () => {
    (service as unknown as Internals).createClient = () => {
      const client = new FakeClient();
      client.initialize.mockRejectedValue(new Error('navigation failed'));
      clients.push(client);
      return client;
    };
    await expect(service.initialize()).resolves.toMatchObject({
      status: WhatsAppConnectionStatus.ERROR,
    });
  });

  it('bounds cleanup operations that never settle', async () => {
    const pending = new Promise<void>(() => undefined);
    await expect(
      (service as unknown as Internals).withTimeout(pending, 10),
    ).rejects.toThrow('Operation timed out after 10ms');
  });

  it('ignores late events from a destroyed generation', async () => {
    const first = service.initialize();
    await ready();
    await first;
    const reconnect = service.reconnect();
    await tick();
    clients[0].emit('ready');
    await ready(clients[1]);
    await reconnect;
    expect((service as unknown as Internals).generation).toBe(2);
    expect(session.status).toBe(WhatsAppConnectionStatus.CONNECTED);
  });

  it('replaces the old generation QR and never returns it', async () => {
    const first = service.initialize();
    await tick();
    clients[0].emit('qr', 'generation-one');
    const oldQr = (await waitForQr()) as {
      qrDataUrl: string;
      generation: number;
    };

    const reconnect = service.reconnect();
    await tick();
    await tick();
    expect(service.getQr()).toMatchObject({ available: false, generation: 2 });
    clients[1].emit('qr', 'generation-two');
    const newQr = (await waitForQr()) as {
      qrDataUrl: string;
      generation: number;
    };
    expect(newQr.generation).toBe(2);
    expect(newQr.qrDataUrl).not.toBe(oldQr.qrDataUrl);
    await ready(clients[1]);
    await Promise.all([first, reconnect]);
  });

  it('clears QR after READY', async () => {
    const operation = service.initialize();
    await tick();
    clients[0].emit('qr', 'temporary');
    await tick();
    await ready();
    await operation;
    expect(service.getQr()).toMatchObject({
      available: false,
      reason: 'ALREADY_CONNECTED',
    });
  });

  it('keeps status and QR reads side-effect free', async () => {
    await service.getStatus();
    service.getQr();
    await service.getStatus();
    expect(clients).toHaveLength(0);
  });

  it('resolves a LID through the provider once and reuses the cache', async () => {
    const operation = service.initialize();
    await ready();
    await operation;

    await expect(
      service.resolveLidIdentity('53296299557012@lid'),
    ).resolves.toEqual({
      lid: '53296299557012@lid',
      chatId: '77086810693@c.us',
      source: 'PROVIDER',
    });
    await expect(
      service.resolveLidIdentity('53296299557012@lid'),
    ).resolves.toEqual({
      lid: '53296299557012@lid',
      chatId: '77086810693@c.us',
      source: 'CACHE',
    });
    expect(clients[0].getContactLidAndPhone).toHaveBeenCalledTimes(1);
  });
});
