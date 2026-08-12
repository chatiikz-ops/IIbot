import {
  ConflictException,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
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
  'IDLE' | 'INITIALIZING' | 'READY' | 'DESTROYING' | 'LOGGING_OUT';

@Injectable()
export class WhatsAppClientService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(WhatsAppClientService.name);
  private client: Client | null = null;
  private authStrategy: LocalAuth | null = null;
  private initializationPromise: Promise<unknown> | null = null;
  private lifecyclePromise: Promise<unknown> | null = null;
  private lifecycleState: LifecycleState = 'IDLE';
  private currentQrDataUrl: string | null = null;
  private currentQrCreatedAt: Date | null = null;
  private status: WhatsAppConnectionStatus = WhatsAppConnectionStatus.DISABLED;
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly ackHandlers: AckHandler[] = [];
  private readonly stateWaiters = new Set<() => void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WhatsAppConfigService,
  ) {}

  async onModuleInit() {
    this.status = this.config.enabled
      ? WhatsAppConnectionStatus.DISCONNECTED
      : WhatsAppConnectionStatus.DISABLED;
    await this.prisma.whatsAppSession.upsert({
      where: { clientId: this.config.clientId },
      create: { clientId: this.config.clientId, status: this.status },
      update: { status: this.status, lastError: null },
    });
    if (this.config.enabled) {
      void this.initialize().catch(() => undefined);
    }
  }

  async onApplicationShutdown() {
    await this.shutdownRuntime();
  }

  onMessage(handler: MessageHandler) {
    this.messageHandlers.push(handler);
  }

  onAck(handler: AckHandler) {
    this.ackHandlers.push(handler);
  }

  initialize() {
    if (!this.config.enabled) return this.getStatus();
    if (this.initializationPromise) return this.initializationPromise;
    this.assertLifecycleAvailable('initialize');
    if (this.client) return this.getStatus();

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
    this.assertLifecycleAvailable('reconnect');
    const operation = this.trackLifecycle(this.performReconnect());
    await operation;
    return this.getStatus();
  }

  async destroy() {
    if (this.lifecycleState === 'DESTROYING' && this.lifecyclePromise) {
      await this.lifecyclePromise;
      return this.getStatus();
    }
    this.assertLifecycleAvailable('destroy');
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
    const session = await this.prisma.whatsAppSession.findUnique({
      where: { clientId: this.config.clientId },
    });
    const status = session?.status ?? this.status;
    return {
      enabled: this.config.enabled,
      status,
      connected: status === WhatsAppConnectionStatus.CONNECTED,
      phoneNumber: session?.phoneNumber ?? null,
      displayName: session?.displayName ?? null,
      lastConnectedAt: session?.lastConnectedAt ?? null,
      lastDisconnectedAt: session?.lastDisconnectedAt ?? null,
      qrAvailable: this.isQrAvailable(),
      lifecycleState: this.lifecycleState,
    };
  }

  getQr() {
    if (this.status === WhatsAppConnectionStatus.CONNECTED) {
      return { available: false, reason: 'ALREADY_CONNECTED' };
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
        };
      }
      return { available: false, reason: 'EXPIRED' };
    }
    if (
      this.status === WhatsAppConnectionStatus.INITIALIZING ||
      this.status === WhatsAppConnectionStatus.AUTHENTICATING
    ) {
      return { available: false, reason: 'INITIALIZING' };
    }
    if (!this.config.enabled) return { available: false, reason: 'DISABLED' };
    return { available: false, reason: 'NOT_AVAILABLE' };
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
      this.lifecycleState = this.client ? 'READY' : 'IDLE';
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
      const client = new Client({
        authStrategy,
        authTimeoutMs: this.config.initTimeoutMs,
        puppeteer: { headless: this.config.headless },
      });
      this.client = client;
      this.authStrategy = authStrategy;
      this.bindEvents(client);

      const statePromise = this.waitForStateOrTimeout();
      const runtimePromise = client.initialize();
      const first = await Promise.race([
        statePromise.then((reached) => ({ kind: 'state' as const, reached })),
        runtimePromise.then(
          () => ({ kind: 'runtime' as const, error: null }),
          (error: unknown) => ({ kind: 'runtime' as const, error }),
        ),
      ]);

      if (first.kind === 'runtime' && first.error) {
        await this.closeFailedClient(client);
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

      const reachedState =
        first.kind === 'state' ? first.reached : await statePromise;
      if (!reachedState) {
        await this.closeFailedClient(client);
        await this.setStatus(WhatsAppConnectionStatus.ERROR, {
          lastError: 'WhatsApp client initialization timed out',
        });
        return;
      }

      void runtimePromise.catch((error: unknown) =>
        this.handleUnexpectedRuntimeFailure(client, error),
      );
      return;
    }
  }

  private async performReconnect() {
    this.lifecycleState = 'DESTROYING';
    if (this.client) await this.closeCurrentClient();
    this.lifecycleState = 'INITIALIZING';
    await this.setStatus(WhatsAppConnectionStatus.INITIALIZING);
    try {
      await this.launchClientWithLockRetry();
    } finally {
      this.lifecycleState = this.client ? 'READY' : 'IDLE';
    }
  }

  private async performDestroy(updateStatus: boolean) {
    this.lifecycleState = 'DESTROYING';
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
        await client.logout();
        remoteLogoutCompleted = true;
      } catch (error) {
        logoutError = error;
      }

      try {
        await client.destroy();
        await this.waitForBrowserClosed(client);
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
    client.removeAllListeners();
    await client.destroy();
    await this.waitForBrowserClosed(client);
    if (this.client === client) {
      this.client = null;
      this.authStrategy = null;
    }
  }

  private async closeFailedClient(client: Client) {
    client.removeAllListeners();
    try {
      await client.destroy();
    } catch {
      // A partially initialized browser may already be closed.
    }
    await this.waitForBrowserClosed(client);
    if (this.client === client) {
      this.client = null;
      this.authStrategy = null;
    }
  }

  private async shutdownRuntime() {
    if (this.lifecyclePromise) {
      await Promise.race([
        this.lifecyclePromise.catch(() => undefined),
        this.delay(5000),
      ]);
    }
    const client = this.client;
    if (!client) return;
    this.lifecycleState = 'DESTROYING';
    await this.closeFailedClient(client);
    this.lifecycleState = 'IDLE';
  }

  private bindEvents(client: Client) {
    client.on('qr', (rawQr) => void this.handleQr(client, rawQr));
    client.on('authenticated', () => {
      void this.guardClient(client, () =>
        this.setStatus(WhatsAppConnectionStatus.AUTHENTICATING),
      );
    });
    client.on('ready', () => {
      void this.guardClient(client, () => this.handleReady(client));
    });
    client.on('auth_failure', () => {
      void this.guardClient(client, () =>
        this.setStatus(WhatsAppConnectionStatus.AUTH_FAILURE, {
          lastError: 'WhatsApp authentication failed',
        }),
      );
    });
    client.on('disconnected', () => {
      void this.guardClient(client, () => this.handleDisconnected());
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

  private async handleQr(client: Client, rawQr: string) {
    if (this.client !== client) return;
    try {
      this.currentQrDataUrl = await QRCode.toDataURL(rawQr, {
        errorCorrectionLevel: 'M',
      });
      this.currentQrCreatedAt = new Date();
      await this.setStatus(WhatsAppConnectionStatus.QR_REQUIRED, {
        lastQrAt: this.currentQrCreatedAt,
        lastError: null,
      });
      this.logger.log('WhatsApp QR is ready for scanning');
    } catch {
      await this.setStatus(WhatsAppConnectionStatus.ERROR, {
        lastError: 'Failed to generate WhatsApp QR image',
      });
    }
  }

  private async handleReady(client: Client) {
    this.clearQr();
    const phoneNumber = client.info?.wid?.user
      ? `+${client.info.wid.user}`
      : null;
    await this.setStatus(WhatsAppConnectionStatus.CONNECTED, {
      phoneNumber,
      displayName: client.info?.pushname ?? null,
      lastConnectedAt: new Date(),
      lastError: null,
    });
    this.logger.log('WhatsApp client connected');
  }

  private async handleDisconnected() {
    this.clearQr();
    await this.setStatus(WhatsAppConnectionStatus.DISCONNECTED, {
      lastDisconnectedAt: new Date(),
    });
    this.logger.warn(
      'WhatsApp client disconnected; manual reconnect is required',
    );
  }

  private async handleUnexpectedRuntimeFailure(client: Client, error: unknown) {
    if (
      this.client !== client ||
      this.lifecycleState === 'DESTROYING' ||
      this.lifecycleState === 'LOGGING_OUT'
    ) {
      return;
    }
    this.lifecycleState = 'DESTROYING';
    await this.closeFailedClient(client);
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
    this.status = status;
    const update = this.prisma.whatsAppSession.upsert({
      where: { clientId: this.config.clientId },
      create: { clientId: this.config.clientId, status, ...data },
      update: { status, ...data },
    });
    return update.then(() => {
      for (const resolve of this.stateWaiters) resolve();
      this.stateWaiters.clear();
    });
  }

  private waitForStateOrTimeout() {
    return new Promise<boolean>((resolve) => {
      const onState = () => {
        clearTimeout(timeout);
        this.stateWaiters.delete(onState);
        resolve(true);
      };
      const timeout = setTimeout(() => {
        this.stateWaiters.delete(onState);
        resolve(false);
      }, this.config.initTimeoutMs);
      this.stateWaiters.add(onState);
    });
  }

  private guardClient(client: Client, operation: () => Promise<void>) {
    if (
      this.client !== client ||
      this.lifecycleState === 'DESTROYING' ||
      this.lifecycleState === 'LOGGING_OUT'
    ) {
      return Promise.resolve();
    }
    return operation().catch(() =>
      this.handleUnexpectedRuntimeFailure(client, new Error('Event failure')),
    );
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
      this.lifecycleState === 'DESTROYING' ||
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
      this.currentQrCreatedAt.getTime() + this.config.qrTtlSeconds * 1000 >
        Date.now(),
    );
  }

  private clearQr() {
    this.currentQrDataUrl = null;
    this.currentQrCreatedAt = null;
  }

  private ensureConnected() {
    if (!this.client || this.status !== WhatsAppConnectionStatus.CONNECTED) {
      throw new ServiceUnavailableException('WhatsApp не подключён');
    }
  }

  private delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
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
      message.from.endsWith('@c.us')
    );
  }

  static externalMessageId(message: WebMessage) {
    return message.id?._serialized ?? null;
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
