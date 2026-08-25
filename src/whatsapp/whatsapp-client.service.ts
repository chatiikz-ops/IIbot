import {
  ConflictException,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import QRCode from 'qrcode';
import {
  Client,
  LocalAuth,
  MessageAck,
  MessageTypes,
  type Message as WebMessage,
} from 'whatsapp-web.js';
import { WhatsAppConnectionStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppConfigService } from './whatsapp-config.service';

type MessageHandler = (message: WebMessage) => Promise<void>;
type AckHandler = (message: WebMessage, ack: MessageAck) => Promise<void>;
type LifecycleState =
  | 'IDLE'
  | 'INITIALIZING'
  | 'READY'
  | 'DISCONNECTED'
  | 'FAILED'
  | 'DISCONNECTING'
  | 'LOGGING_OUT';
type InitializationOutcome = 'READY' | 'FAILED' | 'CANCELLED';

@Injectable()
export class WhatsAppClientService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly lidPhoneCache = new Map<string, string>();
  private readonly logger = new Logger(WhatsAppClientService.name);
  private client: Client | null = null;
  private authStrategy: LocalAuth | null = null;
  private initializationPromise: Promise<unknown> | null = null;
  private reconnectPromise: Promise<unknown> | null = null;
  private lifecyclePromise: Promise<unknown> | null = null;
  private lifecycleState: LifecycleState = 'IDLE';
  private currentQrDataUrl: string | null = null;
  private currentQrCreatedAt: Date | null = null;
  private currentQrGeneration: number | null = null;
  private qrEventSequence = 0;
  private status: WhatsAppConnectionStatus = WhatsAppConnectionStatus.DISABLED;
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly ackHandlers: AckHandler[] = [];
  private generation = 0;
  private readyGeneration = 0;
  private readyEventGeneration = 0;
  private disconnectedGeneration = 0;
  private initializationWaiter: {
    generation: number;
    resolve: (outcome: InitializationOutcome) => void;
  } | null = null;
  private readonly boundClients = new WeakSet<Client>();
  private lifecycleEventQueue: Promise<void> = Promise.resolve();
  private ownsRuntimeLock = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WhatsAppConfigService,
  ) {}

  async onModuleInit() {
    const runtimeEnabled =
      this.config.enabled &&
      (process.env.NODE_ENV !== 'test' ||
        process.env.WHATSAPP_TEST_RUNTIME_ENABLED === 'true');
    if (!runtimeEnabled) {
      this.status = WhatsAppConnectionStatus.DISABLED;
      return;
    }
    this.acquireRuntimeLock();
    this.logger.log({
      event: 'WHATSAPP_RUNTIME_CONFIG',
      clientId: this.config.clientId,
      sessionPath: this.config.sessionPath,
      executablePath: this.config.chromeExecutablePath ?? 'bundled',
      headless: this.config.headless,
      initTimeoutMs: this.config.initTimeoutMs,
    });
    this.status = this.config.enabled
      ? WhatsAppConnectionStatus.DISCONNECTED
      : WhatsAppConnectionStatus.DISABLED;
    await this.prisma.whatsAppSession.upsert({
      where: { clientId: this.config.clientId },
      create: { clientId: this.config.clientId, status: this.status },
      update: { status: this.status, lastError: null },
    });
    if (this.config.enabled) {
      void this.initialize().catch((error: unknown) => {
        this.lifecycleState = 'FAILED';
        this.logLifecycle(
          'bootstrap_initialization_rejected',
          this.generation,
          'error',
          error,
        );
        void this.setStatus(WhatsAppConnectionStatus.ERROR, {
          lastError: 'WhatsApp bootstrap initialization failed',
        }).catch((statusError: unknown) => {
          this.logLifecycle(
            'bootstrap_error_status_failed',
            this.generation,
            'error',
            statusError,
          );
        });
      });
    }
  }

  async onApplicationShutdown() {
    this.logLifecycle('shutdown_started', this.generation);
    try {
      await this.shutdownRuntime();
      this.logLifecycle('shutdown_completed', this.generation);
    } finally {
      this.releaseRuntimeLock();
    }
  }

  onMessage(handler: MessageHandler) {
    this.messageHandlers.push(handler);
  }

  onAck(handler: AckHandler) {
    this.ackHandlers.push(handler);
  }

  async resolveLidIdentity(lid: string) {
    if (!lid.endsWith('@lid')) return null;
    const cached = this.lidPhoneCache.get(lid);
    if (cached) {
      return { lid, chatId: cached, source: 'CACHE' as const };
    }
    const client = this.client;
    if (!client || this.lifecycleState !== 'READY') return null;
    const mappings = await client.getContactLidAndPhone([lid]);
    const mapping = mappings.find((item) => item.lid === lid) ?? mappings[0];
    const chatId = this.validPhoneChatId(mapping?.pn);
    if (!chatId) return null;
    this.lidPhoneCache.set(lid, chatId);
    return { lid, chatId, source: 'PROVIDER' as const };
  }

  private validPhoneChatId(value: unknown) {
    if (typeof value !== 'string' || !/^\d{7,15}@c\.us$/.test(value)) {
      return null;
    }
    return value;
  }

  initialize() {
    if (!this.config.enabled) return this.getStatus();
    if (this.initializationPromise) return this.initializationPromise;
    this.assertLifecycleAvailable('initialize');
    if (this.client) return this.getStatus();
    if (!this.ownsRuntimeLock && this.config.runtimeLockPath)
      this.acquireRuntimeLock();

    const operation = this.performInitialize();
    this.initializationPromise = operation;
    const clearInitialization = () => {
      if (this.initializationPromise === operation) {
        this.initializationPromise = null;
      }
    };
    void operation.then(clearInitialization, clearInitialization);
    return operation;
  }

  async reconnect() {
    if (!this.config.enabled) return this.getStatus();
    if (this.reconnectPromise) return this.reconnectPromise;
    const operation = this.performReconnect().then(() => this.getStatus());
    this.reconnectPromise = operation;
    void operation
      .finally(() => {
        if (this.reconnectPromise === operation) this.reconnectPromise = null;
      })
      .catch(() => undefined);
    await operation;
    return this.getStatus();
  }

  async destroy() {
    if (this.lifecycleState === 'DISCONNECTING' && this.lifecyclePromise) {
      await this.lifecyclePromise;
      return this.getStatus();
    }
    if (
      this.lifecycleState !== 'INITIALIZING' &&
      this.lifecycleState !== 'DISCONNECTED' &&
      this.lifecycleState !== 'FAILED'
    ) {
      this.assertLifecycleAvailable('destroy');
    }
    const operation = this.trackLifecycle(this.performDestroy(true));
    await operation;
    return this.getStatus();
  }

  async logout() {
    this.assertLifecycleAvailable('logout');
    if (!this.client || !this.authStrategy) {
      throw new ConflictException('WhatsApp client не запущен');
    }
    const operation = this.trackLifecycle(this.performLogout());
    await operation;
    return this.getStatus();
  }

  async getStatus() {
    let session = await this.prisma.whatsAppSession.findUnique({
      where: { clientId: this.config.clientId },
    });
    if (
      this.lifecycleState === 'READY' &&
      this.client &&
      (this.status !== WhatsAppConnectionStatus.CONNECTED ||
        session?.status !== WhatsAppConnectionStatus.CONNECTED)
    ) {
      this.logger.warn({
        event: 'WHATSAPP_STATE_INVARIANT_VIOLATION',
        clientInstanceId: `${this.config.clientId}:${this.generation}`,
        generation: this.generation,
        lifecycleState: this.lifecycleState,
        runtimeStatus: this.status,
        persistedStatus: session?.status ?? null,
      });
      await this.setStatus(WhatsAppConnectionStatus.CONNECTED);
      session = await this.prisma.whatsAppSession.findUnique({
        where: { clientId: this.config.clientId },
      });
    }
    const qrAvailable = this.isQrAvailable();
    const status = qrAvailable
      ? WhatsAppConnectionStatus.QR_REQUIRED
      : this.status;
    return {
      enabled: this.config.enabled,
      status,
      connected: status === WhatsAppConnectionStatus.CONNECTED,
      phoneNumber: session?.phoneNumber ?? null,
      displayName: session?.displayName ?? null,
      lastConnectedAt: session?.lastConnectedAt ?? null,
      lastDisconnectedAt: session?.lastDisconnectedAt ?? null,
      qrAvailable,
      ready: status === WhatsAppConnectionStatus.CONNECTED,
      hasQr: qrAvailable,
      phone: session?.phoneNumber ?? null,
      name: session?.displayName ?? null,
      lastError: qrAvailable ? null : (session?.lastError ?? null),
      lifecycleState: this.lifecycleState,
      generation: this.generation,
    };
  }

  getQr() {
    if (this.status === WhatsAppConnectionStatus.CONNECTED) {
      return {
        available: false,
        reason: 'ALREADY_CONNECTED',
        generation: this.generation,
        lifecycleState: this.lifecycleState,
      };
    }
    if (this.currentQrDataUrl && this.currentQrCreatedAt) {
      const expiresAt = new Date(
        this.currentQrCreatedAt.getTime() + this.config.qrTtlSeconds * 1000,
      );
      if (expiresAt.getTime() > Date.now()) {
        return {
          available: true,
          qrDataUrl: this.currentQrDataUrl,
          createdAt: this.currentQrCreatedAt,
          expiresAt,
          generation: this.currentQrGeneration,
          lifecycleState: this.lifecycleState,
        };
      }
      return {
        available: false,
        reason: 'EXPIRED',
        generation: this.generation,
        lifecycleState: this.lifecycleState,
      };
    }
    if (
      this.status === WhatsAppConnectionStatus.INITIALIZING ||
      this.status === WhatsAppConnectionStatus.AUTHENTICATING
    ) {
      return {
        available: false,
        reason: 'INITIALIZING',
        generation: this.generation,
        lifecycleState: this.lifecycleState,
      };
    }
    if (!this.config.enabled)
      return {
        available: false,
        reason: 'DISABLED',
        generation: this.generation,
        lifecycleState: this.lifecycleState,
      };
    return {
      available: false,
      reason: 'NOT_AVAILABLE',
      generation: this.generation,
      lifecycleState: this.lifecycleState,
    };
  }

  async isRegisteredUser(chatId: string) {
    this.ensureConnected();
    return this.client!.isRegisteredUser(chatId);
  }

  async sendText(chatId: string, text: string) {
    this.ensureConnected();
    return this.client!.sendMessage(chatId, text);
  }

  private async performInitialize() {
    this.lifecycleState = 'INITIALIZING';
    await this.setStatus(WhatsAppConnectionStatus.INITIALIZING);
    try {
      await this.launchClientWithLockRetry();
    } finally {
      if (this.lifecycleState === 'INITIALIZING') {
        this.lifecycleState = this.client ? 'FAILED' : 'IDLE';
      }
    }
    return this.getStatus();
  }

  private async launchClientWithLockRetry() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const authStrategy = new LocalAuth({
        clientId: this.config.clientId,
        dataPath: this.config.sessionPath,
        rmMaxRetries: 10,
      });
      const client = this.createClient(authStrategy);
      const generation = ++this.generation;
      this.lidPhoneCache.clear();
      this.clearQr();
      this.client = client;
      this.authStrategy = authStrategy;
      this.bindEvents(client, generation);
      this.logLifecycle('client_created', generation);

      const statePromise = this.waitForInitializationOutcome(generation);
      const runtimePromise = Promise.resolve().then(() => client.initialize());
      const first = await Promise.race([
        statePromise.then((outcome) => ({ kind: 'state' as const, outcome })),
        runtimePromise.then(
          () => ({ kind: 'runtime' as const, error: null }),
          (error: unknown) => ({ kind: 'runtime' as const, error }),
        ),
      ]);

      if (first.kind === 'runtime' && first.error) {
        this.logLifecycle(
          'initialization_failed',
          generation,
          'error',
          first.error,
        );
        await this.closeFailedClient(client, generation);
        if (attempt === 0 && this.isLockError(first.error)) {
          this.logger.warn(
            'WhatsApp LocalAuth profile was busy; retrying after browser shutdown',
          );
          await this.delay(750);
          continue;
        }
        await this.setStatus(WhatsAppConnectionStatus.ERROR, {
          lastError: this.isLockError(first.error)
            ? 'WhatsApp LocalAuth session is used by another process'
            : 'WhatsApp client initialization failed',
        });
        return;
      }

      const outcome =
        first.kind === 'state' ? first.outcome : await statePromise;
      if (outcome !== 'READY') {
        await this.closeFailedClient(client, generation);
        if (
          outcome !== 'CANCELLED' &&
          this.status !== WhatsAppConnectionStatus.AUTH_FAILURE &&
          this.status !== WhatsAppConnectionStatus.DISCONNECTED
        ) {
          await this.setStatus(WhatsAppConnectionStatus.ERROR, {
            lastError: 'WhatsApp client initialization failed or timed out',
          });
        }
        this.lifecycleState = outcome === 'CANCELLED' ? 'IDLE' : 'FAILED';
        return;
      }

      void runtimePromise.catch((error: unknown) => {
        void this.safelyHandleRuntimeFailure(client, generation, error);
      });
      return;
    }
  }

  private async performReconnect() {
    this.cancelInitialization();
    if (this.initializationPromise) {
      await this.initializationPromise.catch(() => undefined);
    }
    this.lifecycleState = 'DISCONNECTING';
    if (this.client) await this.closeCurrentClient();
    if (!this.ownsRuntimeLock && this.config.runtimeLockPath)
      this.acquireRuntimeLock();
    this.lifecycleState = 'INITIALIZING';
    await this.setStatus(WhatsAppConnectionStatus.INITIALIZING);
    try {
      await this.launchClientWithLockRetry();
    } finally {
      if (this.lifecycleState === 'INITIALIZING')
        this.lifecycleState = 'FAILED';
    }
  }

  private async performDestroy(updateStatus: boolean) {
    const startedAt = Date.now();
    this.lifecycleState = 'DISCONNECTING';
    this.logLifecycle(
      'WHATSAPP_DISCONNECT_STARTED',
      this.generation,
      'log',
      undefined,
      { stage: 'disconnect', durationMs: 0 },
    );
    this.cancelInitialization();
    if (this.initializationPromise) {
      try {
        await this.withTimeout(
          this.initializationPromise.catch(() => undefined),
          5000,
        );
      } catch {
        // Cancellation is best-effort; runtime cleanup below is bounded too.
      }
    }
    try {
      if (this.client) await this.closeCurrentClient();
      this.clearQr();
      if (updateStatus && this.config.enabled) {
        await this.setStatus(WhatsAppConnectionStatus.DISCONNECTED, {
          lastDisconnectedAt: new Date(),
        });
      }
    } finally {
      this.lifecycleState = this.client ? 'READY' : 'IDLE';
      this.releaseRuntimeLock();
      this.logLifecycle(
        'WHATSAPP_RUNTIME_LOCK_RELEASED',
        this.generation,
        'log',
        undefined,
        { stage: 'runtime_lock', durationMs: Date.now() - startedAt },
      );
      this.logLifecycle(
        'WHATSAPP_DISCONNECT_COMPLETED',
        this.generation,
        'log',
        undefined,
        { stage: 'disconnect', durationMs: Date.now() - startedAt },
      );
    }
  }

  private async performLogout() {
    this.lifecycleState = 'LOGGING_OUT';
    const client = this.client!;
    const authStrategy = this.authStrategy!;
    const authWithLogout = authStrategy as unknown as {
      logout: () => Promise<void>;
    };
    const originalLogout = authWithLogout.logout;
    const removeLocalAuth = async (): Promise<void> => {
      await originalLogout.call(authStrategy);
    };
    let remoteLogoutCompleted = false;
    let runtimeDestroyCompleted = false;
    let localAuthRemoved = false;
    let logoutError: unknown;
    let destroyError: unknown;

    authWithLogout.logout = () => Promise.resolve();
    client.removeAllListeners('disconnected');
    try {
      try {
        await this.withTimeout(client.logout(), 5000);
        remoteLogoutCompleted = true;
      } catch (error) {
        logoutError = error;
      }

      try {
        await this.withTimeout(client.destroy(), 4000);
        await this.forceCloseBrowser(client, this.generation);
        runtimeDestroyCompleted = true;
      } catch (error) {
        destroyError = error;
      }

      if (runtimeDestroyCompleted && this.client === client) {
        this.client = null;
        this.authStrategy = null;
        this.clearQr();
      }

      if (remoteLogoutCompleted && runtimeDestroyCompleted) {
        await this.delay(300);
        try {
          await this.removeLocalAuthWithRetry(removeLocalAuth);
        } catch {
          await this.setStatus(WhatsAppConnectionStatus.ERROR, {
            lastError: 'LocalAuth could not be removed after Chromium shutdown',
          });
          throw new ServiceUnavailableException(
            'Chromium завершён, но LocalAuth пока занят системой',
          );
        }
        localAuthRemoved = true;
        await this.setStatus(WhatsAppConnectionStatus.DISCONNECTED, {
          phoneNumber: null,
          displayName: null,
          lastDisconnectedAt: new Date(),
          lastError: null,
        });
        return;
      }

      if (runtimeDestroyCompleted) {
        await this.setStatus(WhatsAppConnectionStatus.DISCONNECTED, {
          lastDisconnectedAt: new Date(),
          lastError: 'WhatsApp logout failed; LocalAuth was preserved',
        });
      }
      throw new ServiceUnavailableException(
        logoutError
          ? 'Не удалось завершить WhatsApp logout; LocalAuth сохранён'
          : destroyError
            ? 'Не удалось полностью завершить Chromium; LocalAuth сохранён'
            : 'Не удалось завершить WhatsApp logout',
      );
    } finally {
      if (!localAuthRemoved) {
        authWithLogout.logout = originalLogout;
      }
      this.lifecycleState = this.client ? 'READY' : 'IDLE';
    }
  }

  private async closeCurrentClient() {
    const client = this.client;
    if (!client) return;
    const generation = this.generation;
    const startedAt = Date.now();
    client.removeAllListeners();
    this.logLifecycle(
      'WHATSAPP_CLIENT_DESTROY_STARTED',
      generation,
      'log',
      undefined,
      { stage: 'client.destroy', durationMs: 0 },
    );
    try {
      await this.withTimeout(client.destroy(), 4000);
    } catch (error) {
      this.logLifecycle(
        'WHATSAPP_CLIENT_DESTROY_TIMEOUT',
        generation,
        'warn',
        error,
        { stage: 'client.destroy', durationMs: Date.now() - startedAt },
      );
    }
    await this.forceCloseBrowser(client, generation);
    if (this.client === client) {
      this.client = null;
      this.authStrategy = null;
    }
    this.logLifecycle(
      'WHATSAPP_CLIENT_DESTROY_COMPLETED',
      generation,
      'log',
      undefined,
      { stage: 'client.destroy', durationMs: Date.now() - startedAt },
    );
  }

  private async forceCloseBrowser(client: Client, generation: number) {
    const startedAt = Date.now();
    this.logLifecycle(
      'WHATSAPP_BROWSER_CLOSE_STARTED',
      generation,
      'log',
      undefined,
      { stage: 'browser.close', durationMs: 0 },
    );
    try {
      if (client.pupPage && !client.pupPage.isClosed()) {
        await this.withTimeout(client.pupPage.close(), 1500);
      }
      if (client.pupBrowser?.isConnected()) {
        await this.withTimeout(client.pupBrowser.close(), 2500);
      }
      await this.waitForBrowserClosed(client);
      this.logLifecycle(
        'WHATSAPP_BROWSER_CLOSE_COMPLETED',
        generation,
        'log',
        undefined,
        { stage: 'browser.close', durationMs: Date.now() - startedAt },
      );
    } catch (error) {
      this.logLifecycle(
        'WHATSAPP_BROWSER_CLOSE_TIMEOUT',
        generation,
        'warn',
        error,
        { stage: 'browser.close', durationMs: Date.now() - startedAt },
      );
    }
  }

  private async closeFailedClient(
    client: Client,
    generation = this.generation,
  ) {
    client.removeAllListeners();
    try {
      await this.withTimeout(client.destroy(), 5000);
    } catch (error) {
      // A partially initialized browser may already be closed.
      this.logLifecycle(
        'failed_client_destroy_timeout',
        generation,
        'warn',
        error,
      );
    }
    try {
      await this.waitForBrowserClosed(client);
    } catch (error) {
      this.logLifecycle('browser_close_timeout', generation, 'warn', error);
    }
    if (this.client === client) {
      this.client = null;
      this.authStrategy = null;
    }
  }

  private async shutdownRuntime() {
    this.cancelInitialization();
    if (this.initializationPromise) {
      await Promise.race([
        this.initializationPromise.catch(() => undefined),
        this.delay(5000),
      ]);
    }
    if (this.lifecyclePromise) {
      await Promise.race([
        this.lifecyclePromise.catch(() => undefined),
        this.delay(5000),
      ]);
    }
    const client = this.client;
    if (!client) return;
    this.lifecycleState = 'DISCONNECTING';
    await this.closeFailedClient(client);
    this.lifecycleState = 'IDLE';
  }

  private bindEvents(client: Client, generation: number) {
    if (this.boundClients.has(client)) return;
    this.boundClients.add(client);
    client.on('qr', (rawQr) => {
      this.enqueueLifecycleEvent(client, generation, () =>
        this.handleQr(client, generation, rawQr),
      );
    });
    client.on('authenticated', () => {
      this.enqueueLifecycleEvent(client, generation, () =>
        this.handleAuthenticated(client, generation),
      );
    });
    client.on('ready', () => {
      this.enqueueLifecycleEvent(client, generation, () =>
        this.handleReady(client, generation),
      );
    });
    client.on('auth_failure', () => {
      this.enqueueLifecycleEvent(client, generation, async () => {
        if (this.readyEventGeneration === generation) return;
        this.lifecycleState = 'FAILED';
        this.clearQr();
        await this.setStatus(WhatsAppConnectionStatus.AUTH_FAILURE, {
          lastError: 'WhatsApp authentication failed',
        });
      });
    });
    client.on('disconnected', () => {
      this.enqueueLifecycleEvent(client, generation, () =>
        this.handleDisconnected(generation),
      );
    });
    client.on('change_state', (state) => {
      if (this.client === client && this.generation === generation) {
        this.logLifecycle('state_changed', generation, 'log', undefined, {
          whatsappState: String(state),
        });
      }
    });
    client.on('message', (message) => {
      for (const handler of this.messageHandlers) {
        void handler(message).catch(() =>
          this.logger.error('Failed to persist an inbound WhatsApp message'),
        );
      }
    });
    client.on('message_ack', (message, ack) => {
      for (const handler of this.ackHandlers) {
        void handler(message, ack).catch(() =>
          this.logger.error('Failed to persist a WhatsApp acknowledgement'),
        );
      }
    });
  }

  private async handleQr(client: Client, generation: number, rawQr: string) {
    if (this.client !== client || this.generation !== generation) return;
    const qrEventSequence = ++this.qrEventSequence;
    try {
      const qrDataUrl = await QRCode.toDataURL(rawQr, {
        errorCorrectionLevel: 'M',
      });
      if (
        this.client !== client ||
        this.generation !== generation ||
        this.qrEventSequence !== qrEventSequence ||
        this.lifecycleState === 'READY'
      )
        return;
      this.currentQrDataUrl = qrDataUrl;
      this.currentQrCreatedAt = new Date();
      this.currentQrGeneration = generation;
      this.lifecycleState = 'INITIALIZING';
      await this.setStatus(WhatsAppConnectionStatus.QR_REQUIRED, {
        lastQrAt: this.currentQrCreatedAt,
        lastError: null,
      });
      this.logLifecycle('qr_ready', generation);
    } catch {
      await this.setStatus(WhatsAppConnectionStatus.ERROR, {
        lastError: 'Failed to generate WhatsApp QR image',
      });
    }
  }

  private async handleReady(client: Client, generation: number) {
    if (this.readyEventGeneration === generation) return;
    this.readyEventGeneration = generation;
    this.clearQr();
    const lastConnectedAt = new Date();
    const phoneNumber = client.info?.wid?.user
      ? `+${client.info.wid.user}`
      : null;
    await this.setStatus(WhatsAppConnectionStatus.CONNECTED, {
      phoneNumber,
      displayName: client.info?.pushname ?? null,
      lastConnectedAt,
      lastError: null,
    });
    this.readyGeneration = generation;
    this.lifecycleState = 'READY';
    this.resolveInitialization(generation, 'READY');
    this.logLifecycle('connected', generation);
  }

  private async handleAuthenticated(client: Client, generation: number) {
    if (
      this.client !== client ||
      this.generation !== generation ||
      this.readyGeneration === generation ||
      this.readyEventGeneration === generation ||
      this.lifecycleState === 'READY'
    ) {
      return;
    }
    await this.setStatus(WhatsAppConnectionStatus.AUTHENTICATING);
  }

  private async handleDisconnected(generation: number) {
    if (this.disconnectedGeneration === generation) return;
    this.disconnectedGeneration = generation;
    this.lifecycleState = 'DISCONNECTED';
    this.clearQr();
    await this.setStatus(WhatsAppConnectionStatus.DISCONNECTED, {
      lastDisconnectedAt: new Date(),
    });
    this.resolveInitialization(generation, 'FAILED');
    this.logLifecycle('disconnected', generation, 'warn');
  }

  private async handleUnexpectedRuntimeFailure(
    client: Client,
    generation: number,
    error: unknown,
  ) {
    if (
      this.client !== client ||
      this.lifecycleState === 'DISCONNECTING' ||
      this.lifecycleState === 'LOGGING_OUT'
    ) {
      return;
    }
    this.lifecycleState = 'DISCONNECTING';
    this.resolveInitialization(generation, 'FAILED');
    await this.closeFailedClient(client, generation);
    await this.setStatus(WhatsAppConnectionStatus.ERROR, {
      lastError: this.isLockError(error)
        ? 'WhatsApp LocalAuth session is used by another process'
        : 'WhatsApp runtime failed',
    });
    this.lifecycleState = 'IDLE';
  }

  private async waitForBrowserClosed(client: Client) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!client.pupBrowser?.isConnected()) return;
      await this.delay(100);
    }
    throw new ServiceUnavailableException(
      'Chromium не завершился за допустимое время',
    );
  }

  private async removeLocalAuthWithRetry(remove: () => Promise<void>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await remove();
        return;
      } catch (error) {
        lastError = error;
        if (!this.isLockError(error)) throw error;
        await this.delay(150 * (attempt + 1));
      }
    }
    throw lastError;
  }

  private setStatus(
    status: WhatsAppConnectionStatus,
    data: {
      phoneNumber?: string | null;
      displayName?: string | null;
      lastConnectedAt?: Date;
      lastDisconnectedAt?: Date;
      lastQrAt?: Date;
      lastError?: string | null;
    } = {},
  ) {
    const update = this.prisma.whatsAppSession.upsert({
      where: { clientId: this.config.clientId },
      create: { clientId: this.config.clientId, status, ...data },
      update: { status, ...data },
    });
    return update.then(() => {
      this.status = status;
    });
  }

  private enqueueLifecycleEvent(
    client: Client,
    generation: number,
    operation: () => Promise<void>,
  ) {
    const queued = this.lifecycleEventQueue.then(() =>
      this.safeEvent(client, generation, operation),
    );
    this.lifecycleEventQueue = queued.catch(() => undefined);
  }

  private waitForInitializationOutcome(generation: number) {
    return new Promise<InitializationOutcome>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.readyEventGeneration === generation) return;
        if (this.initializationWaiter?.generation === generation) {
          this.initializationWaiter = null;
        }
        resolve('FAILED');
      }, this.config.initTimeoutMs);
      this.initializationWaiter = {
        generation,
        resolve: (outcome) => {
          clearTimeout(timeout);
          resolve(outcome);
        },
      };
    });
  }

  private resolveInitialization(
    generation: number,
    outcome: InitializationOutcome,
  ) {
    if (this.initializationWaiter?.generation !== generation) return;
    const waiter = this.initializationWaiter;
    this.initializationWaiter = null;
    waiter.resolve(outcome);
  }

  private cancelInitialization() {
    if (!this.initializationWaiter) return;
    this.resolveInitialization(
      this.initializationWaiter.generation,
      'CANCELLED',
    );
  }

  private async safeEvent(
    client: Client,
    generation: number,
    operation: () => Promise<void>,
  ) {
    if (
      this.client !== client ||
      this.generation !== generation ||
      this.lifecycleState === 'DISCONNECTING' ||
      this.lifecycleState === 'LOGGING_OUT'
    ) {
      return;
    }
    try {
      await operation();
    } catch (error) {
      await this.safelyHandleRuntimeFailure(client, generation, error);
    }
  }

  private async safelyHandleRuntimeFailure(
    client: Client,
    generation: number,
    error: unknown,
  ) {
    try {
      await this.handleUnexpectedRuntimeFailure(client, generation, error);
    } catch (secondaryError) {
      this.lifecycleState = 'FAILED';
      this.logLifecycle(
        'runtime_failure_handler_failed',
        generation,
        'error',
        secondaryError,
      );
    }
  }

  private trackLifecycle<T>(operation: Promise<T>) {
    this.lifecyclePromise = operation;
    const clearLifecycle = () => {
      if (this.lifecyclePromise === operation) this.lifecyclePromise = null;
    };
    void operation.then(clearLifecycle, clearLifecycle);
    return operation;
  }

  private assertLifecycleAvailable(operation: string) {
    if (
      this.lifecycleState === 'INITIALIZING' ||
      this.lifecycleState === 'DISCONNECTING' ||
      this.lifecycleState === 'LOGGING_OUT'
    ) {
      throw new ConflictException(
        `Операция ${operation} недоступна: lifecycle=${this.lifecycleState}`,
      );
    }
  }

  private isLockError(error: unknown) {
    if (!(error instanceof Error)) return false;
    const message = `${error.name} ${error.message}`.toLowerCase();
    return (
      message.includes('ebusy') ||
      message.includes('eperm') ||
      message.includes('resource busy') ||
      message.includes('operation not permitted') ||
      message.includes('lockfile') ||
      message.includes('singletonlock') ||
      message.includes('profile appears to be in use') ||
      message.includes('browser is already running')
    );
  }

  private isQrAvailable() {
    return Boolean(
      this.currentQrDataUrl &&
      this.currentQrCreatedAt &&
      this.currentQrGeneration === this.generation &&
      this.currentQrCreatedAt.getTime() + this.config.qrTtlSeconds * 1000 >
        Date.now(),
    );
  }

  private clearQr() {
    this.qrEventSequence += 1;
    this.currentQrDataUrl = null;
    this.currentQrCreatedAt = null;
    this.currentQrGeneration = null;
  }

  private ensureConnected() {
    if (
      !this.client ||
      this.lifecycleState !== 'READY' ||
      this.status !== WhatsAppConnectionStatus.CONNECTED
    ) {
      throw new ServiceUnavailableException('WhatsApp не подключён');
    }
  }

  private delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private acquireRuntimeLock() {
    const lockPath = this.config.runtimeLockPath;
    mkdirSync(this.config.sessionPath, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeFileSync(
          lockPath,
          JSON.stringify({ pid: process.pid, createdAt: new Date() }),
          { flag: 'wx' },
        );
        this.ownsRuntimeLock = true;
        this.logger.log({
          event: 'WHATSAPP_RUNTIME_LOCK_ACQUIRED',
          pid: process.pid,
          lockPath,
        });
        return;
      } catch {
        const existingPid = this.readRuntimeLockPid(lockPath);
        if (
          existingPid &&
          existingPid !== process.pid &&
          this.isPidAlive(existingPid)
        ) {
          throw new ConflictException(
            `WhatsApp LocalAuth profile is owned by backend PID ${existingPid}`,
          );
        }
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          if (attempt > 0) throw unlinkError;
        }
      }
    }
    throw new ConflictException('WhatsApp runtime lock could not be acquired');
  }

  private releaseRuntimeLock() {
    if (!this.ownsRuntimeLock) return;
    this.ownsRuntimeLock = false;
    try {
      if (
        this.readRuntimeLockPid(this.config.runtimeLockPath) === process.pid
      ) {
        unlinkSync(this.config.runtimeLockPath);
      }
    } catch (error) {
      this.logLifecycle(
        'runtime_lock_release_failed',
        this.generation,
        'warn',
        error,
      );
    }
  }

  private readRuntimeLockPid(lockPath: string) {
    try {
      const value = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        pid?: unknown;
      };
      return Number.isInteger(value.pid) ? Number(value.pid) : null;
    } catch {
      return null;
    }
  }

  private isPidAlive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      void operation.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(
            error instanceof Error ? error : new Error('Operation failed'),
          );
        },
      );
    });
  }

  private createClient(authStrategy: LocalAuth) {
    return new Client({
      authStrategy,
      authTimeoutMs: this.config.initTimeoutMs,
      puppeteer: this.config.browserLaunchOptions,
    });
  }

  private logLifecycle(
    event: string,
    generation: number,
    level: 'log' | 'warn' | 'error' = 'log',
    error?: unknown,
    metadata: Record<string, unknown> = {},
  ) {
    const details = {
      event,
      clientInstanceId: `${this.config.clientId}:${generation}`,
      generation,
      lifecycleState: this.lifecycleState,
      ...metadata,
      ...(error instanceof Error
        ? { errorName: error.name, errorMessage: error.message }
        : {}),
    };
    this.logger[level](details);
  }

  static isSupportedInbound(message: WebMessage) {
    return (
      this.isEligibleInbound(message) &&
      message.type === MessageTypes.TEXT &&
      Boolean(message.body?.trim())
    );
  }

  static isEligibleInbound(message: WebMessage) {
    return (
      !message.fromMe &&
      !message.isStatus &&
      !message.broadcast &&
      !message.from.endsWith('@g.us') &&
      (message.from.endsWith('@c.us') || message.from.endsWith('@lid'))
    );
  }

  static externalMessageId(message: WebMessage) {
    return this.externalMessageIdentity(message).value;
  }

  static externalMessageIdentity(message: WebMessage) {
    const serialized = this.nonEmptyString(message.id?._serialized);
    if (serialized) return { value: serialized, source: 'SERIALIZED' as const };

    const innerId = this.nonEmptyString(message.id?.id);
    if (innerId) {
      const remote =
        this.nonEmptyString(message.id?.remote) ??
        this.nonEmptyString(message.from) ??
        'unknown-remote';
      return {
        value: `wwebjs:${remote}:${message.id?.fromMe === true ? '1' : '0'}:${innerId}`,
        source: 'MESSAGE_ID_PARTS' as const,
      };
    }

    const bodyDigest = createHash('sha256')
      .update(message.body ?? '')
      .digest('hex');
    const fallbackDigest = createHash('sha256')
      .update(
        JSON.stringify({
          provider: 'whatsapp-web.js',
          from: message.from ?? null,
          to: message.to ?? null,
          timestamp: Number.isFinite(message.timestamp)
            ? message.timestamp
            : null,
          type: message.type ?? null,
          fromMe: message.fromMe === true,
          bodyDigest,
        }),
      )
      .digest('hex');
    return {
      value: `fallback:sha256:${fallbackDigest}`,
      source: 'FALLBACK_ID' as const,
    };
  }

  private static nonEmptyString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  static ackStatus(ack: MessageAck) {
    if (ack === MessageAck.ACK_SERVER) return 'SENT' as const;
    if (ack === MessageAck.ACK_DEVICE) return 'DELIVERED' as const;
    if (ack === MessageAck.ACK_READ || ack === MessageAck.ACK_PLAYED) {
      return 'READ' as const;
    }
    if (ack === MessageAck.ACK_ERROR) return 'FAILED' as const;
    return null;
  }
}
