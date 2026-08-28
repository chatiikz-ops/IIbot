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
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppConfigService } from './whatsapp-config.service';
import type { ResolvedWhatsAppRecipient } from './transport/whatsapp-transport';

type MessageHandler = (message: WebMessage) => Promise<void>;
type MessageCreateHandler = (
  message: WebMessage,
  generation: number,
) => Promise<void>;
type AckHandler = (
  message: WebMessage,
  ack: MessageAck,
  generation: number,
) => Promise<void>;
export type WhatsAppRuntimeState =
  | 'DISABLED'
  | 'IDLE'
  | 'STARTING'
  | 'QR_REQUIRED'
  | 'AUTHENTICATING'
  | 'CONNECTED'
  | 'DISCONNECTING'
  | 'LOGGING_OUT'
  | 'ERROR';
type InitializationOutcome =
  'CONNECTED' | 'QR_REQUIRED' | 'ERROR' | 'CANCELLED';

export class WhatsAppRuntimeError extends Error {
  readonly code = 'WHATSAPP_RUNTIME_UNHEALTHY';
  readonly retryable = true;

  constructor(
    message: string,
    readonly outcomeAmbiguous: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WhatsAppRuntimeError';
  }
}

export class WhatsAppRuntimeStabilizingError extends Error {
  readonly code = 'WHATSAPP_RUNTIME_STABILIZING';
  readonly retryable = true;
  readonly outcomeAmbiguous = false;

  constructor() {
    super('WhatsApp Web runtime is temporarily stabilizing after navigation');
    this.name = 'WhatsAppRuntimeStabilizingError';
  }
}

@Injectable()
export class WhatsAppClientService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly lidPhoneCache = new Map<string, string>();
  private readonly logger = new Logger(WhatsAppClientService.name);
  private client: Client | null = null;
  private authStrategy: LocalAuth | null = null;
  private currentOperation: {
    kind: 'INITIALIZE' | 'RECONNECT' | 'DESTROY' | 'LOGOUT';
    promise: Promise<unknown>;
  } | null = null;
  private state: WhatsAppRuntimeState = 'IDLE';
  private currentQrDataUrl: string | null = null;
  private currentQrCreatedAt: Date | null = null;
  private currentQrGeneration: number | null = null;
  private qrEventSequence = 0;
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly messageCreateHandlers: MessageCreateHandler[] = [];
  private readonly ackHandlers: AckHandler[] = [];
  private generation = 0;
  private operationCompletion: {
    generation: number;
    resolve: (outcome: InitializationOutcome) => void;
  } | null = null;
  private readonly boundClients = new WeakSet<Client>();
  private eventQueue: Promise<void> = Promise.resolve();
  private ownsRuntimeLock = false;
  private recoveryPromise: Promise<void> | null = null;
  private readonly healthBoundClients = new WeakSet<Client>();
  private navigationStabilization: {
    client: Client;
    generation: number;
    startedAt: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WhatsAppConfigService,
  ) {}

  async onModuleInit() {
    if ((this.config.transport ?? 'whatsapp-webjs') !== 'whatsapp-webjs')
      return;
    const runtimeEnabled =
      this.config.enabled &&
      (process.env.NODE_ENV !== 'test' ||
        process.env.WHATSAPP_TEST_RUNTIME_ENABLED === 'true');
    if (!runtimeEnabled) {
      this.state = 'DISABLED';
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
    this.state = this.config.enabled ? 'IDLE' : 'DISABLED';
    await this.prisma.whatsAppSession.upsert({
      where: { clientId: this.config.clientId },
      create: { clientId: this.config.clientId, status: this.state },
      update: { status: this.state, lastError: null },
    });
    if (this.config.enabled) {
      void this.initialize().catch((error: unknown) => {
        this.state = 'ERROR';
        this.logLifecycle(
          'bootstrap_initialization_rejected',
          this.generation,
          'error',
          error,
        );
        void this.transitionTo('ERROR', {
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
    if ((this.config.transport ?? 'whatsapp-webjs') !== 'whatsapp-webjs')
      return;
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

  onMessageCreate(handler: MessageCreateHandler) {
    this.messageCreateHandlers.push(handler);
  }

  onAck(handler: AckHandler) {
    this.ackHandlers.push(handler);
  }

  getGeneration() {
    return this.generation;
  }

  async resolveLidIdentity(lid: string) {
    if (!lid.endsWith('@lid')) return null;
    const cached = this.lidPhoneCache.get(lid);
    if (cached) {
      return { lid, chatId: cached, source: 'CACHE' as const };
    }
    const client = this.client;
    if (!client || this.state !== 'CONNECTED') return null;
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

  private validCanonicalChatId(value: unknown) {
    if (typeof value !== 'string' || !/^\d{7,20}@(c\.us|lid)$/.test(value)) {
      return null;
    }
    return value;
  }

  private chatIdDomain(value: string | null) {
    if (value?.endsWith('@c.us')) return 'c.us' as const;
    if (value?.endsWith('@lid')) return 'lid' as const;
    return 'unknown' as const;
  }

  private safeChatIdDomain(value: unknown) {
    if (typeof value !== 'string') return null;
    if (value.endsWith('@c.us')) return 'c.us';
    if (value.endsWith('@lid')) return 'lid';
    return 'unknown';
  }

  initialize() {
    if (!this.config.enabled) return this.getStatus();
    if (this.currentOperation?.kind === 'INITIALIZE') {
      return this.currentOperation.promise;
    }
    if (this.currentOperation) this.operationConflict('initialize');
    this.assertLifecycleAvailable('initialize');
    if (this.client) return this.getStatus();
    if (!this.ownsRuntimeLock && this.config.runtimeLockPath)
      this.acquireRuntimeLock();

    const operation = this.performInitialize();
    return this.trackOperation('INITIALIZE', operation);
  }

  async reconnect() {
    if (!this.config.enabled) return this.getStatus();
    if (this.currentOperation?.kind === 'RECONNECT') {
      await this.currentOperation.promise;
      return this.getStatus();
    }
    const previousOperation = this.currentOperation?.promise ?? null;
    const operation = this.performReconnect(previousOperation).then(() =>
      this.getStatus(),
    );
    void this.trackOperation('RECONNECT', operation);
    await operation;
    return this.getStatus();
  }

  async destroy() {
    if (this.currentOperation?.kind === 'DESTROY') {
      await this.currentOperation.promise;
      return this.getStatus();
    }
    if (
      this.state !== 'STARTING' &&
      this.state !== 'IDLE' &&
      this.state !== 'ERROR'
    ) {
      this.assertLifecycleAvailable('destroy');
    }
    const previousOperation = this.currentOperation?.promise ?? null;
    const operation = this.trackOperation(
      'DESTROY',
      this.performDestroy(true, previousOperation),
    );
    await operation;
    return this.getStatus();
  }

  async logout() {
    if (this.currentOperation?.kind === 'LOGOUT') {
      await this.currentOperation.promise;
      return this.getStatus();
    }
    if (this.currentOperation) this.operationConflict('logout');
    this.assertLifecycleAvailable('logout');
    if (!this.client || !this.authStrategy) {
      throw new ConflictException('WhatsApp client не запущен');
    }
    const operation = this.trackOperation('LOGOUT', this.performLogout());
    await operation;
    return this.getStatus();
  }

  async getStatus() {
    const session = await this.prisma.whatsAppSession.findUnique({
      where: { clientId: this.config.clientId },
    });
    if (session && session.status !== this.state) {
      this.logger.warn({
        event: 'WHATSAPP_STATE_INVARIANT_VIOLATION',
        clientInstanceId: `${this.config.clientId}:${this.generation}`,
        generation: this.generation,
        runtimeState: this.state,
        persistedStatus: session?.status ?? null,
      });
      void this.persistState(this.state).catch(() => undefined);
    }
    const qrAvailable = this.isQrAvailable();
    return {
      enabled: this.config.enabled,
      state: this.state,
      connected: this.state === 'CONNECTED',
      phoneNumber: session?.phoneNumber ?? null,
      displayName: session?.displayName ?? null,
      lastConnectedAt: session?.lastConnectedAt ?? null,
      lastDisconnectedAt: session?.lastDisconnectedAt ?? null,
      qrAvailable,
      lastError: this.state === 'ERROR' ? (session?.lastError ?? null) : null,
      generation: this.generation,
    };
  }

  getQr() {
    if (this.state === 'CONNECTED') {
      return {
        available: false,
        reason: 'ALREADY_CONNECTED',
        generation: this.generation,
        state: this.state,
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
          state: this.state,
        };
      }
      return {
        available: false,
        reason: 'EXPIRED',
        generation: this.generation,
        state: this.state,
      };
    }
    if (this.state === 'STARTING' || this.state === 'AUTHENTICATING') {
      return {
        available: false,
        reason: 'STARTING',
        generation: this.generation,
        state: this.state,
      };
    }
    if (!this.config.enabled)
      return {
        available: false,
        reason: 'DISABLED',
        generation: this.generation,
        state: this.state,
      };
    return {
      available: false,
      reason: 'NOT_AVAILABLE',
      generation: this.generation,
      state: this.state,
    };
  }

  async isRegisteredUser(chatId: string) {
    this.ensureConnected();
    this.ensureRuntimeNotStabilizing();
    return this.client!.isRegisteredUser(chatId);
  }

  async resolveRecipient(chatId: string): Promise<ResolvedWhatsAppRecipient> {
    this.ensureConnected();
    this.ensureRuntimeNotStabilizing();
    const candidateChatId = this.validPhoneChatId(chatId);
    if (!candidateChatId) {
      return {
        candidateChatId: chatId,
        canonicalChatId: null,
        canonicalDomain: 'unknown',
        registered: false,
        resolutionSource: 'fallback',
      };
    }
    const result = await this.client!.getNumberId(candidateChatId);
    const canonicalChatId = this.validCanonicalChatId(result?._serialized);
    return {
      candidateChatId,
      canonicalChatId,
      canonicalDomain: this.chatIdDomain(canonicalChatId),
      registered: Boolean(canonicalChatId),
      resolutionSource: 'getNumberId',
    };
  }

  async sendText(chatId: string, text: string) {
    this.ensureConnected();
    this.ensureRuntimeNotStabilizing();
    const client = this.client!;
    const generation = this.generation;
    const health = this.runtimeHealth(client, generation);
    this.logger.log({ event: 'WHATSAPP_RUNTIME_HEALTH', ...health });
    if (!health.browserConnected || health.pageClosed) {
      const error = new WhatsAppRuntimeError(
        'WhatsApp Chromium runtime is not healthy before sendMessage',
        false,
      );
      this.markRuntimeUnhealthy(client, generation, error, health);
      throw error;
    }
    try {
      const result = await client.sendMessage(chatId, text);
      const candidate = result as WebMessage | null | undefined;
      this.logger.log({
        event: 'WHATSAPP_SEND_PROVIDER_RESULT',
        typeOfResult: typeof result,
        hasId: Boolean(candidate?.id),
        idSerializedPresent: Boolean(
          WhatsAppClientService.nonEmptyString(candidate?.id?._serialized),
        ),
        idInnerPresent: Boolean(
          WhatsAppClientService.nonEmptyString(candidate?.id?.id),
        ),
        remoteDomain: this.safeChatIdDomain(candidate?.id?.remote),
        fromMe: candidate?.id?.fromMe === true,
        constructorName:
          result && typeof result === 'object'
            ? (result.constructor?.name ?? null)
            : null,
      });
      if (client !== this.client || generation !== this.generation) {
        this.logger.warn({
          event: 'WHATSAPP_SEND_STALE_CLIENT_GENERATION',
          sendGeneration: generation,
          currentGeneration: this.generation,
        });
      }
      return candidate;
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      this.logger.error({
        event: 'WHATSAPP_SEND_PROVIDER_ERROR',
        generation,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack:
          error instanceof Error ? (error.stack?.slice(0, 8000) ?? null) : null,
        errorCause: this.safeErrorValue(cause),
      });
      if (this.isRuntimeFatalError(error)) {
        this.markRuntimeUnhealthy(client, generation, error);
      }
      throw error;
    }
  }

  private async performInitialize() {
    const startedAt = Date.now();
    this.logLifecycle('WHATSAPP_INITIALIZE_STARTED', this.generation);
    await this.transitionTo('STARTING');
    if (this.state !== 'STARTING') return this.getStatus();
    try {
      await this.launchClientWithLockRetry();
    } finally {
      if (this.state === 'STARTING') {
        this.state = this.client ? 'ERROR' : 'IDLE';
      }
      this.logLifecycle(
        this.state === 'ERROR'
          ? 'WHATSAPP_INITIALIZE_FAILED'
          : 'WHATSAPP_INITIALIZE_COMPLETED',
        this.generation,
        this.state === 'ERROR' ? 'error' : 'log',
        undefined,
        { durationMs: Date.now() - startedAt },
      );
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
      this.logLifecycle('WHATSAPP_CLIENT_CREATED', generation);

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
        await this.transitionTo('ERROR', {
          lastError: this.isLockError(first.error)
            ? 'WhatsApp LocalAuth session is used by another process'
            : 'WhatsApp client initialization failed',
        });
        return;
      }

      const outcome =
        first.kind === 'state' ? first.outcome : await statePromise;
      if (outcome === 'QR_REQUIRED') {
        void runtimePromise.catch((error: unknown) => {
          void this.safelyHandleRuntimeFailure(client, generation, error);
        });
        return;
      }
      if (outcome !== 'CONNECTED') {
        await this.closeFailedClient(client, generation);
        if (outcome !== 'CANCELLED' && this.state !== 'ERROR') {
          await this.transitionTo('ERROR', {
            lastError: 'WhatsApp client initialization failed or timed out',
          });
        }
        this.state = outcome === 'CANCELLED' ? 'IDLE' : 'ERROR';
        return;
      }

      void runtimePromise.catch((error: unknown) => {
        void this.safelyHandleRuntimeFailure(client, generation, error);
      });
      return;
    }
  }

  private async performReconnect(previousOperation: Promise<unknown> | null) {
    const startedAt = Date.now();
    this.cancelNavigationStabilization();
    this.logLifecycle('WHATSAPP_RECONNECT_STARTED', this.generation);
    await this.transitionTo('DISCONNECTING');
    this.cancelInitialization();
    if (previousOperation) {
      await previousOperation.catch(() => undefined);
    }
    if (this.client) await this.closeCurrentClient();
    if (!this.ownsRuntimeLock && this.config.runtimeLockPath)
      this.acquireRuntimeLock();
    await this.transitionTo('STARTING');
    try {
      await this.launchClientWithLockRetry();
    } finally {
      if (this.state === 'STARTING') this.state = 'ERROR';
      this.logLifecycle(
        this.state === 'ERROR'
          ? 'WHATSAPP_RECONNECT_FAILED'
          : 'WHATSAPP_RECONNECT_COMPLETED',
        this.generation,
        this.state === 'ERROR' ? 'error' : 'log',
        undefined,
        { durationMs: Date.now() - startedAt },
      );
    }
  }

  private async performDestroy(
    updateStatus: boolean,
    previousOperation: Promise<unknown> | null,
  ) {
    const startedAt = Date.now();
    this.cancelNavigationStabilization();
    await this.transitionTo('DISCONNECTING');
    this.logLifecycle(
      'WHATSAPP_DISCONNECT_STARTED',
      this.generation,
      'log',
      undefined,
      { stage: 'disconnect', durationMs: 0 },
    );
    this.cancelInitialization();
    if (previousOperation) {
      try {
        await this.withTimeout(
          previousOperation.catch(() => undefined),
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
        await this.transitionTo('IDLE', {
          lastDisconnectedAt: new Date(),
        });
      }
    } finally {
      if (this.client) await this.transitionTo('CONNECTED');
      else if (this.state !== 'IDLE') await this.transitionTo('IDLE');
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
    const startedAt = Date.now();
    this.cancelNavigationStabilization();
    await this.transitionTo('LOGGING_OUT');
    this.logLifecycle('WHATSAPP_LOGOUT_STARTED', this.generation, 'log');
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
          await this.transitionTo('ERROR', {
            lastError: 'LocalAuth could not be removed after Chromium shutdown',
          });
          throw new ServiceUnavailableException(
            'Chromium завершён, но LocalAuth пока занят системой',
          );
        }
        localAuthRemoved = true;
        await this.transitionTo('IDLE', {
          phoneNumber: null,
          displayName: null,
          lastDisconnectedAt: new Date(),
          lastError: null,
        });
        return;
      }

      if (runtimeDestroyCompleted) {
        await this.transitionTo('IDLE', {
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
      if (this.client) await this.transitionTo('CONNECTED');
      else if (this.state !== 'IDLE') await this.transitionTo('IDLE');
      this.releaseRuntimeLock();
      this.logLifecycle(
        'WHATSAPP_LOGOUT_COMPLETED',
        this.generation,
        'log',
        undefined,
        { durationMs: Date.now() - startedAt },
      );
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
    if (this.currentOperation) {
      await Promise.race([
        this.currentOperation.promise.catch(() => undefined),
        this.delay(5000),
      ]);
    }
    const client = this.client;
    if (!client) return;
    await this.transitionTo('DISCONNECTING');
    await this.closeFailedClient(client);
    await this.transitionTo('IDLE', { lastDisconnectedAt: new Date() });
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
        if (this.state === 'CONNECTED') return;
        this.clearQr();
        await this.transitionTo('ERROR', {
          lastError: 'WhatsApp authentication failed',
        });
        this.logLifecycle('WHATSAPP_AUTH_FAILURE', generation, 'warn');
      });
    });
    client.on('disconnected', () => {
      this.enqueueLifecycleEvent(client, generation, () =>
        this.handleDisconnected(generation),
      );
    });
    client.on('change_state', (state) => {
      this.enqueueLifecycleEvent(client, generation, () => {
        this.logLifecycle('state_changed', generation, 'log', undefined, {
          whatsappState: String(state),
        });
        return Promise.resolve();
      });
    });
    client.on('message', (message) => {
      for (const handler of this.messageHandlers) {
        void handler(message).catch(() =>
          this.logger.error('Failed to persist an inbound WhatsApp message'),
        );
      }
    });
    client.on('message_create', (message) => {
      if (this.client !== client || this.generation !== generation) return;
      for (const handler of this.messageCreateHandlers) {
        void handler(message, generation).catch(() =>
          this.logger.error('Failed to correlate an outbound WhatsApp message'),
        );
      }
    });
    client.on('message_ack', (message, ack) => {
      if (this.client !== client || this.generation !== generation) return;
      for (const handler of this.ackHandlers) {
        void handler(message, ack, generation).catch(() =>
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
        this.state === 'CONNECTED'
      )
        return;
      this.currentQrDataUrl = qrDataUrl;
      this.currentQrCreatedAt = new Date();
      this.currentQrGeneration = generation;
      await this.transitionTo('QR_REQUIRED', {
        lastQrAt: this.currentQrCreatedAt,
        lastError: null,
      });
      this.resolveInitialization(generation, 'QR_REQUIRED');
      this.logLifecycle('WHATSAPP_QR_CREATED', generation);
    } catch {
      await this.transitionTo('ERROR', {
        lastError: 'Failed to generate WhatsApp QR image',
      });
    }
  }

  private async handleReady(client: Client, generation: number) {
    if (this.state === 'CONNECTED') return;
    this.bindRuntimeHealthEvents(client, generation);
    const health = this.runtimeHealth(client, generation);
    if (!health.browserConnected || health.pageClosed) {
      this.markRuntimeUnhealthy(
        client,
        generation,
        new WhatsAppRuntimeError(
          'WhatsApp Chromium became unhealthy before ready completed',
          false,
        ),
        health,
      );
      return;
    }
    this.clearQr();
    const lastConnectedAt = new Date();
    const phoneNumber = client.info?.wid?.user
      ? `+${client.info.wid.user}`
      : null;
    await this.transitionTo('CONNECTED', {
      phoneNumber,
      displayName: client.info?.pushname ?? null,
      lastConnectedAt,
      lastError: null,
    });
    this.resolveInitialization(generation, 'CONNECTED');
    this.logLifecycle('WHATSAPP_READY', generation);
  }

  private bindRuntimeHealthEvents(client: Client, generation: number) {
    if (this.healthBoundClients.has(client)) return;
    this.healthBoundClients.add(client);
    client.pupBrowser?.once('disconnected', () => {
      if (this.ignoreExpectedRuntimeClose(client, generation, 'browser'))
        return;
      this.logger.error({
        event: 'WHATSAPP_BROWSER_DISCONNECTED',
        generation,
      });
      void this.markRuntimeUnhealthy(
        client,
        generation,
        new WhatsAppRuntimeError('Chromium browser disconnected', false),
      );
    });
    client.pupPage?.once('close', () => {
      if (this.ignoreExpectedRuntimeClose(client, generation, 'page')) return;
      this.logger.error({ event: 'WHATSAPP_PAGE_CLOSED', generation });
      void this.markRuntimeUnhealthy(
        client,
        generation,
        new WhatsAppRuntimeError('WhatsApp Web page closed', false),
      );
    });
    client.pupPage?.once('error', (error) => {
      void this.markRuntimeUnhealthy(client, generation, error);
    });
    client.pupPage?.on('framenavigated', (frame) => {
      if (frame !== client.pupPage?.mainFrame()) return;
      if (this.state !== 'CONNECTED') return;
      this.handlePostReadyNavigation(client, generation);
    });
  }

  private ensureRuntimeNotStabilizing() {
    const stabilization = this.navigationStabilization;
    if (
      stabilization &&
      stabilization.client === this.client &&
      stabilization.generation === this.generation
    ) {
      throw new WhatsAppRuntimeStabilizingError();
    }
  }

  private handlePostReadyNavigation(client: Client, generation: number) {
    if (client !== this.client || generation !== this.generation) return;
    this.logger.warn({
      event: 'WHATSAPP_RUNTIME_NAVIGATION_DETECTED',
      generation,
      state: this.state,
    });
    if (this.navigationStabilization) return;

    const startedAt = Date.now();
    const graceMs = this.navigationGraceMs();
    this.logger.warn({
      event: 'WHATSAPP_RUNTIME_STABILIZATION_STARTED',
      generation,
      state: this.state,
      durationMs: graceMs,
    });
    const timer = setTimeout(() => {
      void this.finishNavigationStabilization(client, generation, startedAt);
    }, graceMs);
    this.navigationStabilization = { client, generation, startedAt, timer };
  }

  private async finishNavigationStabilization(
    client: Client,
    generation: number,
    startedAt: number,
  ) {
    const stabilization = this.navigationStabilization;
    if (
      !stabilization ||
      stabilization.client !== client ||
      stabilization.generation !== generation
    ) {
      return;
    }
    this.navigationStabilization = null;
    const health = this.runtimeHealth(client, generation);
    const healthy =
      client === this.client &&
      generation === this.generation &&
      this.state === 'CONNECTED' &&
      health.browserConnected &&
      !health.pageClosed &&
      (await this.hasConnectedProviderState(client));
    const durationMs = Date.now() - startedAt;
    if (healthy) {
      this.logger.log({
        event: 'WHATSAPP_RUNTIME_NAVIGATION_RECOVERED',
        generation,
        state: this.state,
        durationMs,
      });
      return;
    }
    this.logger.error({
      event: 'WHATSAPP_RUNTIME_NAVIGATION_FAILED',
      generation,
      durationMs,
      ...health,
    });
    this.markRuntimeUnhealthy(
      client,
      generation,
      new WhatsAppRuntimeError(
        'WhatsApp Web did not recover after navigation grace period',
        false,
      ),
      health,
    );
  }

  private async hasConnectedProviderState(client: Client) {
    try {
      return String(await client.getState()) === 'CONNECTED';
    } catch {
      return false;
    }
  }

  private navigationGraceMs() {
    const configured = Number(
      process.env.WHATSAPP_RUNTIME_NAVIGATION_GRACE_MS ?? 7000,
    );
    return Number.isFinite(configured) && configured >= 100
      ? Math.min(configured, 30_000)
      : 7000;
  }

  private ignoreExpectedRuntimeClose(
    client: Client,
    generation: number,
    kind: 'page' | 'browser',
  ) {
    const expected =
      client !== this.client ||
      generation !== this.generation ||
      this.state === 'DISCONNECTING' ||
      this.state === 'LOGGING_OUT' ||
      this.state === 'ERROR' ||
      Boolean(this.recoveryPromise);
    if (!expected) return false;
    this.logger.log({
      event:
        kind === 'page'
          ? 'WHATSAPP_EXPECTED_PAGE_CLOSE_IGNORED'
          : 'WHATSAPP_EXPECTED_BROWSER_DISCONNECT_IGNORED',
      generation,
      state: this.state,
      durationMs: 0,
    });
    return true;
  }

  private cancelNavigationStabilization() {
    if (!this.navigationStabilization) return;
    clearTimeout(this.navigationStabilization.timer);
    this.navigationStabilization = null;
  }

  private runtimeHealth(client: Client, generation: number) {
    const page = client.pupPage;
    const pageClosed = !page || page.isClosed();
    const browserConnected = Boolean(client.pupBrowser?.isConnected());
    let pageUrl: string | null = null;
    if (!pageClosed) {
      try {
        pageUrl = page?.url() ?? null;
      } catch {
        pageUrl = null;
      }
    }
    return {
      browserConnected,
      pageClosed,
      pageUrl,
      clientGeneration: generation,
      state: this.state,
    };
  }

  private markRuntimeUnhealthy(
    client: Client,
    generation: number,
    error: unknown,
    health = this.runtimeHealth(client, generation),
  ) {
    if (
      this.client !== client ||
      this.generation !== generation ||
      this.state === 'DISCONNECTING' ||
      this.state === 'LOGGING_OUT'
    ) {
      return;
    }
    this.cancelNavigationStabilization();
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('execution context was destroyed')) {
      this.logger.error({
        event: 'WHATSAPP_EXECUTION_CONTEXT_DESTROYED',
        generation,
      });
    }
    this.logger.error({
      event: 'WHATSAPP_RUNTIME_UNHEALTHY',
      ...health,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: message,
    });
    if (this.recoveryPromise) return;

    const previousState = this.state;
    this.state = 'ERROR';
    this.logger.log({
      event: 'WHATSAPP_STATE_CHANGED',
      generation: this.generation,
      previousState,
      nextState: 'ERROR',
    });
    const recovery = (async () => {
      await this.persistState('ERROR', {
        lastError: `WhatsApp Chromium runtime unhealthy: ${message}`.slice(
          0,
          1000,
        ),
      });
      this.logger.warn({
        event: 'WHATSAPP_RUNTIME_RECOVERY_STARTED',
        generation,
      });
      try {
        await this.reconnect();
        if (this.state !== 'CONNECTED') {
          throw new Error(`Recovery completed with state=${this.state}`);
        }
        this.logger.log({
          event: 'WHATSAPP_RUNTIME_RECOVERY_COMPLETED',
          generation: this.generation,
        });
      } catch (recoveryError) {
        this.state = 'ERROR';
        this.logger.error({
          event: 'WHATSAPP_RUNTIME_RECOVERY_FAILED',
          generation,
          errorName:
            recoveryError instanceof Error
              ? recoveryError.name
              : 'UnknownError',
          errorMessage:
            recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError),
        });
      }
    })();
    const trackedRecovery = recovery.finally(() => {
      if (this.recoveryPromise === trackedRecovery) {
        this.recoveryPromise = null;
      }
    });
    this.recoveryPromise = trackedRecovery;
  }

  private isRuntimeFatalError(error: unknown) {
    if (!(error instanceof Error)) return false;
    const value = `${error.name} ${error.message}`.toLowerCase();
    return [
      'targetcloseerror',
      'target closed',
      'execution context was destroyed',
      'protocol error (runtime.evaluate)',
      'session closed',
    ].some((pattern) => value.includes(pattern));
  }

  private async handleAuthenticated(client: Client, generation: number) {
    if (
      this.client !== client ||
      this.generation !== generation ||
      this.state === 'CONNECTED'
    ) {
      return;
    }
    await this.transitionTo('AUTHENTICATING');
    this.logLifecycle('WHATSAPP_AUTHENTICATED', generation);
  }

  private async handleDisconnected(generation: number) {
    if (this.state === 'IDLE') return;
    this.clearQr();
    await this.transitionTo('IDLE', {
      lastDisconnectedAt: new Date(),
    });
    this.resolveInitialization(generation, 'ERROR');
    this.logLifecycle('WHATSAPP_DISCONNECTED', generation, 'warn');
  }

  private async handleUnexpectedRuntimeFailure(
    client: Client,
    generation: number,
    error: unknown,
  ) {
    if (
      this.client !== client ||
      this.state === 'DISCONNECTING' ||
      this.state === 'LOGGING_OUT'
    ) {
      return;
    }
    this.state = 'DISCONNECTING';
    this.resolveInitialization(generation, 'ERROR');
    await this.closeFailedClient(client, generation);
    await this.transitionTo('ERROR', {
      lastError: this.isLockError(error)
        ? 'WhatsApp LocalAuth session is used by another process'
        : 'WhatsApp runtime failed',
    });
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

  private async transitionTo(
    state: WhatsAppRuntimeState,
    data: {
      phoneNumber?: string | null;
      displayName?: string | null;
      lastConnectedAt?: Date;
      lastDisconnectedAt?: Date;
      lastQrAt?: Date;
      lastError?: string | null;
    } = {},
  ) {
    const previousState = this.state;
    this.state = state;
    this.logger.log({
      event: 'WHATSAPP_STATE_CHANGED',
      generation: this.generation,
      previousState,
      nextState: state,
    });
    await this.persistState(state, data);
  }

  private async persistState(
    state: WhatsAppRuntimeState,
    data: {
      phoneNumber?: string | null;
      displayName?: string | null;
      lastConnectedAt?: Date;
      lastDisconnectedAt?: Date;
      lastQrAt?: Date;
      lastError?: string | null;
    } = {},
  ) {
    try {
      await this.prisma.whatsAppSession.upsert({
        where: { clientId: this.config.clientId },
        create: { clientId: this.config.clientId, status: state, ...data },
        update: { status: state, ...data },
      });
    } catch (error) {
      this.logLifecycle(
        'WHATSAPP_STATE_PERSISTENCE_FAILED',
        this.generation,
        'error',
        error,
        { nextState: state },
      );
    }
  }

  private enqueueLifecycleEvent(
    client: Client,
    generation: number,
    operation: () => Promise<void>,
  ) {
    const queued = this.eventQueue.then(() =>
      this.safeEvent(client, generation, operation),
    );
    this.eventQueue = queued.catch(() => undefined);
  }

  private waitForInitializationOutcome(generation: number) {
    return new Promise<InitializationOutcome>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.state === 'CONNECTED') return;
        if (this.operationCompletion?.generation === generation) {
          this.operationCompletion = null;
        }
        resolve('ERROR');
      }, this.config.initTimeoutMs);
      this.operationCompletion = {
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
    if (this.operationCompletion?.generation !== generation) return;
    const waiter = this.operationCompletion;
    this.operationCompletion = null;
    waiter.resolve(outcome);
  }

  private cancelInitialization() {
    if (!this.operationCompletion) return;
    this.resolveInitialization(
      this.operationCompletion.generation,
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
      this.state === 'DISCONNECTING' ||
      this.state === 'LOGGING_OUT'
    ) {
      this.logger.warn({
        event: 'WHATSAPP_STALE_EVENT_IGNORED',
        generation,
        currentGeneration: this.generation,
        state: this.state,
      });
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
      this.state = 'ERROR';
      this.logLifecycle(
        'runtime_failure_handler_failed',
        generation,
        'error',
        secondaryError,
      );
    }
  }

  private trackOperation<T>(
    kind: 'INITIALIZE' | 'RECONNECT' | 'DESTROY' | 'LOGOUT',
    operation: Promise<T>,
  ) {
    this.currentOperation = { kind, promise: operation };
    const clearOperation = () => {
      if (this.currentOperation?.promise === operation) {
        this.currentOperation = null;
      }
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  private operationConflict(operation: string): never {
    throw new ConflictException(
      `WhatsApp operation ${operation} conflicts with ${this.currentOperation?.kind ?? 'unknown'}`,
    );
  }

  private assertLifecycleAvailable(operation: string) {
    if (
      this.state === 'STARTING' ||
      this.state === 'DISCONNECTING' ||
      this.state === 'LOGGING_OUT'
    ) {
      throw new ConflictException(
        `Операция ${operation} недоступна: lifecycle=${this.state}`,
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
    if (!this.client || this.state !== 'CONNECTED') {
      throw new ServiceUnavailableException({
        code: 'WHATSAPP_NOT_CONNECTED',
        message: `WhatsApp outbound is unavailable while state=${this.state}`,
        state: this.state,
      });
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
        if (existingPid && this.isPidAlive(existingPid)) {
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
      this.logger.log({
        event: 'WHATSAPP_RUNTIME_LOCK_RELEASED',
        generation: this.generation,
        pid: process.pid,
        lockPath: this.config.runtimeLockPath,
      });
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
      state: this.state,
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

  static externalMessageId(message: WebMessage | null | undefined) {
    return this.externalMessageIdentity(message).value;
  }

  static externalMessageIdentity(message: WebMessage | null | undefined) {
    const messageId: (WebMessage['id'] & { $1?: unknown }) | undefined =
      message?.id;
    const serialized =
      this.nonEmptyString(messageId?._serialized) ??
      this.nonEmptyString(messageId?.$1);
    if (serialized) return { value: serialized, source: 'SERIALIZED' as const };

    const innerId = this.nonEmptyString(message?.id?.id);
    if (innerId) {
      const remote =
        this.nonEmptyString(message?.id?.remote) ??
        this.nonEmptyString(message?.from) ??
        'unknown-remote';
      return {
        value: `wwebjs:${remote}:${message?.id?.fromMe === true ? '1' : '0'}:${innerId}`,
        source: 'MESSAGE_ID_PARTS' as const,
      };
    }

    const bodyDigest = createHash('sha256')
      .update(message?.body ?? '')
      .digest('hex');
    const fallbackDigest = createHash('sha256')
      .update(
        JSON.stringify({
          provider: 'whatsapp-web.js',
          from: message?.from ?? null,
          to: message?.to ?? null,
          timestamp: Number.isFinite(message?.timestamp)
            ? message?.timestamp
            : null,
          type: message?.type ?? null,
          fromMe: message?.fromMe === true,
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

  private safeErrorValue(value: unknown) {
    if (value instanceof Error) {
      return { name: value.name, message: value.message.slice(0, 2000) };
    }
    if (typeof value === 'string') return value.slice(0, 2000);
    if (value === null || value === undefined) return null;
    return '[non-error cause]';
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
