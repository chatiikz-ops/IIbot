import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { WhatsAppConnectionStatus } from '../generated/prisma/enums';
import { WhatsAppClientService } from './whatsapp-client.service';

class FakeClient extends EventEmitter {
  private readonly mainFrameToken = {};
  initialize = jest.fn<Promise<void>, []>();
  private pageClosed = false;
  destroy = jest.fn<Promise<void>, []>(() => {
    this.pageClosed = true;
    this.pupBrowser.isConnected.mockReturnValue(false);
    return Promise.resolve(undefined);
  });
  logout = jest.fn(() => Promise.resolve(undefined));
  isRegisteredUser = jest.fn(() => Promise.resolve(true));
  getNumberId = jest.fn((id: string) => Promise.resolve({ _serialized: id }));
  getState = jest.fn(() => Promise.resolve('CONNECTED'));
  sendMessage = jest.fn<
    Promise<{ id: string } | { id: { _serialized: string } }>,
    [string, string]
  >(() => Promise.resolve({ id: 'sent' }));
  getContactLidAndPhone = jest.fn(() =>
    Promise.resolve([
      {
        lid: '53296299557012@lid',
        pn: '77086810693@c.us',
      },
    ]),
  );
  pupBrowser = {
    isConnected: jest.fn(() => true),
    close: jest.fn(() => {
      this.pupBrowser.isConnected.mockReturnValue(false);
      return Promise.resolve();
    }),
    once: jest.fn(),
  };
  pupPage = {
    isClosed: jest.fn(() => this.pageClosed),
    close: jest.fn(() => {
      this.pageClosed = true;
      return Promise.resolve();
    }),
    url: jest.fn(() => 'https://web.whatsapp.com/'),
    mainFrame: jest.fn(() => this.mainFrameToken),
    once: jest.fn(),
    on: jest.fn(),
  };
  info = { wid: { user: '77001234567' }, pushname: 'Test' };
}

type Internals = {
  createClient: () => FakeClient;
  state: string;
  generation: number;
  client: FakeClient | null;
  authStrategy: { logout: jest.Mock<Promise<void>, []> } | null;
  recoveryPromise: Promise<void> | null;
  navigationStabilization: unknown;
  markRuntimeUnhealthy(
    client: FakeClient,
    generation: number,
    error: Error,
  ): void;
  acquireRuntimeLock(): void;
  releaseRuntimeLock(): void;
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
    process.env.WHATSAPP_RUNTIME_NAVIGATION_GRACE_MS = '100';
    clients = [];
    session = { status: WhatsAppConnectionStatus.IDLE };
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
  const navigate = (client: FakeClient) => {
    const calls = client.pupPage.on.mock.calls as Array<
      [string, (frame: unknown) => void]
    >;
    const listener = calls.find(([event]) => event === 'framenavigated')?.[1];
    listener?.(client.pupPage.mainFrame());
  };
  const pageClose = (client: FakeClient) => {
    const calls = client.pupPage.once.mock.calls as Array<[string, () => void]>;
    const listener = calls.find(([event]) => event === 'close')?.[1];
    listener?.();
  };
  const browserDisconnect = (client: FakeClient) => {
    const calls = client.pupBrowser.once.mock.calls as Array<
      [string, () => void]
    >;
    const listener = calls.find(([event]) => event === 'disconnected')?.[1];
    listener?.();
  };
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

  it('completes initialization with QR_REQUIRED after QR', async () => {
    const operation = service.initialize();
    let settled = false;
    void operation.then(() => (settled = true));
    await tick();
    clients[0].emit('qr', 'raw-qr');
    const availableQr = await waitForQr();
    await operation;
    expect(settled).toBe(true);
    expect(availableQr).toMatchObject({
      available: true,
      generation: 1,
      state: 'QR_REQUIRED',
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
    expect(session.status).toBe(WhatsAppConnectionStatus.ERROR);

    clients[0].emit('qr', 'fresh-qr');
    await waitForQr();
    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'QR_REQUIRED',
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
      state: 'AUTHENTICATING',
      connected: false,
    });

    await ready();
    await operation;

    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'CONNECTED',
      connected: true,
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
      state: 'CONNECTED',
      connected: true,
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
      ([arg]) => arg.update.status === WhatsAppConnectionStatus.IDLE,
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
    if (clients[0]) expect(clients[0].destroy).toHaveBeenCalledTimes(1);
    expect((service as unknown as Internals).state).toBe('IDLE');
  });

  it('completes normal destroy quickly and persists DISCONNECTED', async () => {
    const initialization = service.initialize();
    await ready();
    await initialization;
    const startedAt = Date.now();
    await service.destroy();
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(session.status).toBe(WhatsAppConnectionStatus.IDLE);
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
    expect(session.status).toBe(WhatsAppConnectionStatus.IDLE);
    expect((service as unknown as Internals).state).toBe('IDLE');
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
    expect(session.status).toBe(WhatsAppConnectionStatus.IDLE);
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
      state: 'CONNECTED',
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
    expect((service as unknown as Internals).state).toBe('IDLE');
    expect(session.status).toBe(WhatsAppConnectionStatus.IDLE);
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
      state: 'CONNECTED',
      generation: 1,
    });
    await restored.onApplicationShutdown();
  });

  it('moves auth failure to a terminal failed state', async () => {
    const operation = service.initialize();
    await tick();
    clients[0].emit('auth_failure', 'bad session');
    await operation;
    expect(session.status).toBe(WhatsAppConnectionStatus.ERROR);
    expect((service as unknown as Internals).state).toBe('ERROR');
  });

  it('contains an initialize rejection and reports ERROR', async () => {
    (service as unknown as Internals).createClient = () => {
      const client = new FakeClient();
      client.initialize.mockRejectedValue(new Error('navigation failed'));
      clients.push(client);
      return client;
    };
    await expect(service.initialize()).resolves.toMatchObject({
      state: 'ERROR',
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

  it('rejects outbound in every non-CONNECTED state and allows it when connected', async () => {
    await expect(
      service.sendText('77001234567@c.us', 'hello'),
    ).rejects.toMatchObject({
      // Jest's asymmetric matcher is intentionally dynamic at this boundary.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      response: expect.objectContaining({ code: 'WHATSAPP_NOT_CONNECTED' }),
    });
    const operation = service.initialize();
    await ready();
    await operation;
    await expect(
      service.sendText('77001234567@c.us', 'hello'),
    ).resolves.toEqual({ id: 'sent' });
  });

  it('leaves CONNECTED after a fatal send transport failure', async () => {
    const operation = service.initialize();
    await ready();
    await operation;
    clients[0].sendMessage.mockRejectedValueOnce(
      new Error('Execution context was destroyed'),
    );

    await expect(service.sendText('77001234567@c.us', 'hello')).rejects.toThrow(
      'Execution context was destroyed',
    );
    await expect(service.getStatus()).resolves.toMatchObject({
      connected: false,
    });
    await tick();
    expect(clients).toHaveLength(2);
    await ready(clients[1]);
    await (service as unknown as Internals).recoveryPromise;
    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'CONNECTED',
      connected: true,
    });
  });

  it('keeps the same CONNECTED generation after healthy internal navigation', async () => {
    const operation = service.initialize();
    await ready();
    await operation;

    navigate(clients[0]);
    await new Promise((resolve) => setTimeout(resolve, 120));

    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'CONNECTED',
      generation: 1,
      connected: true,
    });
    expect(clients).toHaveLength(1);
    expect(clients[0].destroy).not.toHaveBeenCalled();
  });

  it('blocks outbound during navigation and enables it after stabilization', async () => {
    const operation = service.initialize();
    await ready();
    await operation;

    navigate(clients[0]);
    await expect(
      service.sendText('77001234567@c.us', 'blocked'),
    ).rejects.toMatchObject({
      code: 'WHATSAPP_RUNTIME_STABILIZING',
      retryable: true,
      outcomeAmbiguous: false,
    });
    await expect(
      service.isRegisteredUser('77001234567@c.us'),
    ).rejects.toMatchObject({ code: 'WHATSAPP_RUNTIME_STABILIZING' });

    await new Promise((resolve) => setTimeout(resolve, 120));
    await expect(
      service.sendText('77001234567@c.us', 'allowed'),
    ).resolves.toEqual({ id: 'sent' });
  });

  it.each([
    ['77001234567@c.us', 'c.us'],
    ['53296299557012@lid', 'lid'],
  ] as const)(
    'uses canonical getNumberId result %s',
    async (canonical, domain) => {
      const operation = service.initialize();
      await ready();
      await operation;
      clients[0].getNumberId.mockResolvedValueOnce({ _serialized: canonical });

      await expect(
        service.resolveRecipient('77001234567@c.us'),
      ).resolves.toMatchObject({
        canonicalChatId: canonical,
        canonicalDomain: domain,
        registered: true,
        resolutionSource: 'getNumberId',
      });
    },
  );

  it('treats a null getNumberId result as not registered', async () => {
    const operation = service.initialize();
    await ready();
    await operation;
    clients[0].getNumberId.mockResolvedValueOnce(null as never);

    await expect(
      service.resolveRecipient('77001234567@c.us'),
    ).resolves.toMatchObject({
      canonicalChatId: null,
      canonicalDomain: 'unknown',
      registered: false,
    });
  });

  it('coalesces navigation events and recovers once if runtime stays unhealthy', async () => {
    const operation = service.initialize();
    await ready();
    await operation;

    navigate(clients[0]);
    navigate(clients[0]);
    navigate(clients[0]);
    clients[0].pupPage.isClosed.mockReturnValue(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await tick();

    expect(clients).toHaveLength(2);
    await ready(clients[1]);
    await (service as unknown as Internals).recoveryPromise;
    expect(clients[0].destroy).toHaveBeenCalledTimes(1);
    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'CONNECTED',
      generation: 2,
    });
  });

  it('navigation plus browser disconnect starts exactly one recovery', async () => {
    const operation = service.initialize();
    await ready();
    await operation;

    navigate(clients[0]);
    clients[0].pupBrowser.isConnected.mockReturnValue(false);
    browserDisconnect(clients[0]);
    browserDisconnect(clients[0]);
    await tick();

    expect(clients).toHaveLength(2);
    await ready(clients[1]);
    await (service as unknown as Internals).recoveryPromise;
    expect(clients[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('ignores page close emitted by controlled cleanup', async () => {
    const operation = service.initialize();
    await ready();
    await operation;
    const oldClient = clients[0];

    const reconnect = service.reconnect();
    await tick();
    pageClose(oldClient);
    browserDisconnect(oldClient);
    await ready(clients[1]);
    await reconnect;

    expect(clients).toHaveLength(2);
    expect(oldClient.destroy).toHaveBeenCalledTimes(1);
    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'CONNECTED',
      generation: 2,
    });
  });

  it('rejects outbound and recovers when CONNECTED page is closed', async () => {
    const operation = service.initialize();
    await ready();
    await operation;
    clients[0].pupPage.isClosed.mockReturnValue(true);

    await expect(
      service.sendText('77001234567@c.us', 'hello'),
    ).rejects.toMatchObject({ code: 'WHATSAPP_RUNTIME_UNHEALTHY' });
    await expect(service.getStatus()).resolves.toMatchObject({
      connected: false,
    });
    await tick();
    await ready(clients[1]);
    await (service as unknown as Internals).recoveryPromise;
    expect(clients).toHaveLength(2);
  });

  it('rejects outbound and recovers when browser is disconnected', async () => {
    const operation = service.initialize();
    await ready();
    await operation;
    clients[0].pupBrowser.isConnected.mockReturnValue(false);

    await expect(
      service.sendText('77001234567@c.us', 'hello'),
    ).rejects.toMatchObject({ code: 'WHATSAPP_RUNTIME_UNHEALTHY' });
    await tick();
    await ready(clients[1]);
    await (service as unknown as Internals).recoveryPromise;
    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'CONNECTED',
    });
  });

  it('TargetCloseError starts one recovery and blocks outbound meanwhile', async () => {
    const operation = service.initialize();
    await ready();
    await operation;
    const targetClosed = Object.assign(
      new Error('Protocol error: Target closed'),
      {
        name: 'TargetCloseError',
      },
    );
    clients[0].sendMessage.mockRejectedValueOnce(targetClosed);

    await expect(service.sendText('77001234567@c.us', 'hello')).rejects.toBe(
      targetClosed,
    );
    await expect(
      service.sendText('77001234567@c.us', 'blocked'),
    ).rejects.toMatchObject({
      // Jest's asymmetric matcher is intentionally dynamic at this boundary.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      response: expect.objectContaining({ code: 'WHATSAPP_NOT_CONNECTED' }),
    });
    await tick();
    expect(clients).toHaveLength(2);
    await ready(clients[1]);
    await (service as unknown as Internals).recoveryPromise;
    expect(clients[0].destroy).toHaveBeenCalledTimes(1);
    expect(clients[1].destroy).not.toHaveBeenCalled();
  });

  it('ignores runtime-fatal notifications from a stale browser generation', async () => {
    const initial = service.initialize();
    await ready();
    await initial;
    const oldClient = clients[0];
    const reconnect = service.reconnect();
    await tick();
    await ready(clients[1]);
    await reconnect;

    (service as unknown as Internals).markRuntimeUnhealthy(
      oldClient,
      1,
      new Error('Target closed'),
    );
    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'CONNECTED',
      generation: 2,
    });
    expect(clients).toHaveLength(2);
  });

  it('does not hide a provider result from a stale client generation', async () => {
    const operation = service.initialize();
    await ready();
    await operation;
    type SendValue = { id: string } | { id: { _serialized: string } };
    let resolveSend: (value: SendValue | PromiseLike<SendValue>) => void = () =>
      undefined;
    clients[0].sendMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    const send = service.sendText('77001234567@c.us', 'hello');
    (service as unknown as Internals).generation = 2;
    resolveSend({ id: { _serialized: 'provider-stale-generation' } });

    await expect(send).resolves.toMatchObject({
      id: { _serialized: 'provider-stale-generation' },
    });
  });

  it('keeps runtime CONNECTED when persistence fails after ready', async () => {
    upsert.mockImplementationOnce(() => Promise.resolve(session));
    upsert.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    const operation = service.initialize();
    await ready();
    await operation;
    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'CONNECTED',
      connected: true,
    });
  });

  it('ignores a stale disconnected event after a new generation is connected', async () => {
    const initial = service.initialize();
    await ready();
    await initial;
    const reconnect = service.reconnect();
    await tick();
    await ready(clients[1]);
    await reconnect;
    clients[0].emit('disconnected', 'late-old-client-event');
    await tick();
    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'CONNECTED',
      generation: 2,
    });
  });

  it('logout removes LocalAuth and the following initialize requests a QR', async () => {
    const initial = service.initialize();
    await ready();
    await initial;
    const removeLocalAuth = jest.fn(() => Promise.resolve());
    (service as unknown as Internals).authStrategy = {
      logout: removeLocalAuth,
    };
    await service.logout();
    expect(removeLocalAuth).toHaveBeenCalledTimes(1);
    const next = service.initialize();
    await tick();
    clients[1].emit('qr', 'new-login');
    await next;
    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'QR_REQUIRED',
      qrAvailable: true,
    });
  });

  it('recovers stale runtime locks and rejects an active lock', () => {
    const directory = mkdtempSync(join(tmpdir(), 'whatsapp-lock-'));
    const lockPath = join(directory, '.runtime-test.lock');
    const makeLockService = () =>
      new WhatsAppClientService(
        {} as never,
        {
          enabled: true,
          clientId: 'test',
          sessionPath: directory,
          runtimeLockPath: lockPath,
        } as never,
      ) as unknown as Internals;
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: 2147483647 }));
      const owner = makeLockService();
      expect(() => owner.acquireRuntimeLock()).not.toThrow();
      const contender = makeLockService();
      expect(() => contender.acquireRuntimeLock()).toThrow(
        /owned by backend PID/,
      );
      owner.releaseRuntimeLock();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
