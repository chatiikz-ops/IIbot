/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
import {
  ConflictException,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import {
  AckType,
  SocketState,
  create,
  type Ack,
  type Whatsapp,
} from '@wppconnect-team/wppconnect';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppConfigService } from '../whatsapp-config.service';
import type {
  TransportMessage,
  WhatsAppTransport,
  WhatsAppTransportState,
} from './whatsapp-transport';

@Injectable()
export class WppConnectTransport
  implements WhatsAppTransport, OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(WppConnectTransport.name);
  private client: Whatsapp | null = null;
  private state: WhatsAppTransportState = 'IDLE';
  private qr: { dataUrl: string; createdAt: Date; generation: number } | null =
    null;
  private generation = 0;
  private operation: Promise<unknown> | null = null;
  private ownsLock = false;
  private readonly messageHandlers: Array<
    (message: TransportMessage) => Promise<void>
  > = [];
  private readonly createHandlers: Array<
    (message: TransportMessage, generation: number) => Promise<void>
  > = [];
  private readonly ackHandlers: Array<
    (
      message: TransportMessage,
      ack: number,
      generation: number,
    ) => Promise<void>
  > = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WhatsAppConfigService,
  ) {}

  onModuleInit() {
    if (this.config.transport !== 'wppconnect') return;
    if (!this.config.enabled) {
      this.state = 'DISABLED';
      return;
    }
    this.acquireLock();
    void this.initialize().catch((error: unknown) =>
      this.failInitialization(error),
    );
  }

  async onApplicationShutdown() {
    if (this.config.transport === 'wppconnect') {
      try {
        await this.disconnect();
      } finally {
        this.releaseLock();
      }
    }
  }

  initialize() {
    if (this.operation) return this.operation;
    if (this.client && this.state === 'CONNECTED') return this.getStatus();
    this.operation = this.initializeOnce().finally(
      () => (this.operation = null),
    );
    return this.operation;
  }

  async reconnect() {
    if (this.operation) return this.operation;
    await this.disconnect();
    return this.initialize();
  }

  destroy() {
    return this.disconnect();
  }

  async disconnect() {
    if (!this.client) {
      this.state = this.config.enabled ? 'IDLE' : 'DISABLED';
      return this.getStatus();
    }
    this.state = 'DISCONNECTING';
    const client = this.client;
    this.client = null;
    await this.withTimeout(client.close(), 15_000, 'disconnect');
    this.state = 'IDLE';
    this.qr = null;
    await this.persist({ lastDisconnectedAt: new Date() });
    this.logger.log({
      event: 'WHATSAPP_TRANSPORT_DISCONNECTED',
      transport: 'wppconnect',
      generation: this.generation,
    });
    return this.getStatus();
  }

  async logout() {
    if (!this.client)
      throw new ConflictException('WhatsApp client is not running');
    this.state = 'LOGGING_OUT';
    const client = this.client;
    this.client = null;
    await this.withTimeout(client.logout(), 15_000, 'logout');
    await this.withTimeout(client.close(), 15_000, 'close after logout').catch(
      () => false,
    );
    this.state = 'IDLE';
    this.qr = null;
    await this.persist({
      phoneNumber: null,
      displayName: null,
      lastDisconnectedAt: new Date(),
    });
    return this.getStatus();
  }

  async getStatus() {
    const session = await this.prisma.whatsAppSession.findUnique({
      where: { clientId: this.config.clientId },
    });
    return {
      enabled: this.config.enabled,
      state: this.state,
      connected: this.state === 'CONNECTED',
      phoneNumber: session?.phoneNumber ?? null,
      displayName: session?.displayName ?? null,
      lastConnectedAt: session?.lastConnectedAt ?? null,
      lastDisconnectedAt: session?.lastDisconnectedAt ?? null,
      qrAvailable: Boolean(this.qr) && this.state === 'QR_REQUIRED',
      lastError: this.state === 'ERROR' ? (session?.lastError ?? null) : null,
      generation: this.generation,
    };
  }

  getQr() {
    if (!this.qr || this.state === 'CONNECTED')
      return {
        available: false,
        state: this.state,
        generation: this.generation,
      };
    return {
      available: true,
      qrDataUrl: this.qr.dataUrl,
      createdAt: this.qr.createdAt,
      generation: this.qr.generation,
      state: this.state,
    };
  }

  async sendText(chatId: string, text: string) {
    this.ensureConnected();
    if (!(await this.client!.isConnected())) {
      this.state = 'IDLE';
      await this.persist({ lastError: 'WPPConnect provider is disconnected' });
      throw new ServiceUnavailableException({
        code: 'WHATSAPP_NOT_CONNECTED',
        message: 'WhatsApp provider is disconnected',
      });
    }
    const generation = this.generation;
    this.logger.log({
      event: 'WHATSAPP_TRANSPORT_SEND_STARTED',
      transport: 'wppconnect',
      generation,
    });
    try {
      const result = await this.client!.sendText(chatId, text);
      const message = this.normalizeMessage(result);
      this.logger.log({
        event: 'WHATSAPP_TRANSPORT_SEND_RESULT',
        transport: 'wppconnect',
        generation,
        hasProviderId: Boolean(message.id?._serialized),
      });
      if (!message.id?._serialized) return undefined;
      await this.emitCreate(message, generation);
      return message;
    } catch (error) {
      this.logger.error({
        event: 'WHATSAPP_TRANSPORT_SEND_FAILED',
        transport: 'wppconnect',
        generation,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async isRegisteredUser(chatId: string) {
    this.ensureConnected();
    const result = await this.client!.checkNumberStatus(chatId);
    return Boolean(result?.canReceiveMessage);
  }

  async resolveRecipient(chatId: string) {
    this.ensureConnected();
    const result = await this.client!.checkNumberStatus(chatId);
    const serialized = result?.id?._serialized;
    const canonicalChatId =
      typeof serialized === 'string' &&
      /^\d{7,20}@(c\.us|lid)$/.test(serialized)
        ? serialized
        : null;
    return {
      candidateChatId: chatId,
      canonicalChatId,
      canonicalDomain: canonicalChatId?.endsWith('@lid')
        ? ('lid' as const)
        : canonicalChatId?.endsWith('@c.us')
          ? ('c.us' as const)
          : ('unknown' as const),
      registered: Boolean(result?.canReceiveMessage && canonicalChatId),
      resolutionSource: 'provider' as const,
    };
  }

  async resolveLidIdentity(lid: string) {
    if (!lid.endsWith('@lid') || !this.client) return null;
    const entry = await this.client.getPnLidEntry(lid);
    const chatId = entry.phoneNumber?._serialized;
    if (!chatId?.endsWith('@c.us')) return null;
    return { lid, chatId, source: 'PROVIDER' };
  }

  onMessage(handler: (message: TransportMessage) => Promise<void>) {
    this.messageHandlers.push(handler);
  }
  onMessageCreate(
    handler: (message: TransportMessage, generation: number) => Promise<void>,
  ) {
    this.createHandlers.push(handler);
  }
  onAck(
    handler: (
      message: TransportMessage,
      ack: number,
      generation: number,
    ) => Promise<void>,
  ) {
    this.ackHandlers.push(handler);
  }
  getGeneration() {
    return this.generation;
  }

  private async initializeOnce() {
    this.generation += 1;
    const generation = this.generation;
    this.state = 'STARTING';
    mkdirSync(this.config.wppConnectSessionPath, {
      recursive: true,
      mode: 0o700,
    });
    this.logger.log({
      event: 'WHATSAPP_TRANSPORT_INITIALIZING',
      transport: 'wppconnect',
      generation,
    });
    const client = await this.withTimeout(
      create({
        session: this.config.clientId,
        folderNameToken: this.config.wppConnectSessionPath,
        headless: this.config.headless,
        logQR: false,
        updatesLog: false,
        disableWelcome: true,
        autoClose: 0,
        waitForLogin: true,
        puppeteerOptions: this.config.browserLaunchOptions,
        catchQR: (qrCode) => void this.handleQr(qrCode, generation),
        statusFind: (status) =>
          this.handleProviderState(String(status), generation),
      }),
      this.config.initTimeoutMs,
      'initialize',
    );
    if (generation !== this.generation) {
      await client.close();
      return this.getStatus();
    }
    this.client = client;
    this.bindClient(client, generation);
    await this.ready(generation);
    return this.getStatus();
  }

  private bindClient(client: Whatsapp, generation: number) {
    client.onMessage(
      (message) =>
        void this.emitMessage(this.normalizeMessage(message), generation),
    );
    client.onAck((ack) => void this.emitAck(ack, generation));
    client.onStateChange((state) =>
      this.handleProviderState(state, generation),
    );
  }

  private async handleQr(qrCode: string, generation: number) {
    if (generation !== this.generation) return;
    this.state = 'QR_REQUIRED';
    this.qr = {
      dataUrl: await QRCode.toDataURL(qrCode),
      createdAt: new Date(),
      generation,
    };
    await this.persist();
    this.logger.log({
      event: 'WHATSAPP_TRANSPORT_QR',
      transport: 'wppconnect',
      generation,
    });
  }

  private handleProviderState(state: string, generation: number) {
    if (generation !== this.generation) return;
    if (state === 'CONNECTED' || state === 'isLogged')
      void this.ready(generation);
    else if (state === 'PAIRING' || state === 'qrReadSuccess')
      this.state = 'AUTHENTICATING';
    else if (
      [
        SocketState.CONFLICT,
        SocketState.TIMEOUT,
        SocketState.UNLAUNCHED,
      ].includes(state as SocketState)
    )
      void this.disconnected(generation, state);
  }

  private async ready(generation: number) {
    if (generation !== this.generation || !this.client) return;
    const host = await this.client.getHostDevice().catch(() => null);
    this.state = 'CONNECTED';
    this.qr = null;
    await this.persist({
      phoneNumber: host?.wid?.user ?? host?.me?.user ?? null,
      displayName: host?.pushname ?? null,
      lastConnectedAt: new Date(),
      lastError: null,
    });
    this.logger.log({
      event: 'WHATSAPP_TRANSPORT_READY',
      transport: 'wppconnect',
      generation,
    });
  }

  private async disconnected(generation: number, reason: string) {
    if (generation !== this.generation) return;
    this.state = 'IDLE';
    await this.persist({ lastDisconnectedAt: new Date(), lastError: reason });
    this.logger.warn({
      event: 'WHATSAPP_TRANSPORT_DISCONNECTED',
      transport: 'wppconnect',
      generation,
      reason,
    });
  }

  private normalizeMessage(message: any): TransportMessage {
    const serialized =
      typeof message?.id === 'string' ? message.id : message?.id?._serialized;
    const remote = message?.fromMe ? message?.to : message?.from;
    return {
      ...message,
      id: {
        _serialized: serialized,
        id: serialized,
        remote,
        fromMe: message?.fromMe === true,
      },
      body: message?.body ?? message?.content ?? '',
      timestamp:
        message?.timestamp ?? message?.t ?? Math.floor(Date.now() / 1000),
      hasMedia: Boolean(message?.isMedia),
      downloadMedia: async () => this.client?.downloadMedia(message),
      getContact: () =>
        Promise.resolve({ number: String(message?.sender?.id?.user ?? '') }),
    } as TransportMessage;
  }

  private async emitMessage(message: TransportMessage, generation: number) {
    if (generation === this.generation)
      await Promise.all(
        this.messageHandlers.map((handler) => handler(message)),
      );
  }
  private async emitCreate(message: TransportMessage, generation: number) {
    if (generation === this.generation)
      await Promise.all(
        this.createHandlers.map((handler) => handler(message, generation)),
      );
  }
  private async emitAck(ack: Ack, generation: number) {
    if (generation !== this.generation) return;
    const message = this.normalizeMessage({
      ...ack,
      fromMe: ack.id?.fromMe,
      id: ack.id,
    });
    await Promise.all(
      this.ackHandlers.map((handler) =>
        handler(message, Number(ack.ack), generation),
      ),
    );
  }

  private ensureConnected() {
    if (!this.client || this.state !== 'CONNECTED')
      throw new ServiceUnavailableException({
        code: 'WHATSAPP_NOT_CONNECTED',
        message: 'WhatsApp is not connected',
      });
  }
  private async persist(extra: Record<string, unknown> = {}) {
    await this.prisma.whatsAppSession.upsert({
      where: { clientId: this.config.clientId },
      create: { clientId: this.config.clientId, status: this.state, ...extra },
      update: { status: this.state, ...extra },
    });
  }
  private async failInitialization(error: unknown) {
    this.state = 'ERROR';
    await this.persist({
      lastError: error instanceof Error ? error.message : String(error),
    });
  }

  private acquireLock() {
    mkdirSync(this.config.wppConnectSessionPath, {
      recursive: true,
      mode: 0o700,
    });
    const lockPath = join(
      this.config.wppConnectSessionPath,
      `.runtime-${this.config.clientId}.lock`,
    );
    const createLock = () => {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, String(process.pid), 'utf8');
      closeSync(fd);
      this.ownsLock = true;
    };
    try {
      createLock();
    } catch (error) {
      const ownerPid = Number(readFileSync(lockPath, 'utf8'));
      let ownerAlive = Number.isInteger(ownerPid) && ownerPid > 0;
      if (ownerAlive) {
        try {
          process.kill(ownerPid, 0);
        } catch {
          ownerAlive = false;
        }
      }
      if (!ownerAlive) {
        unlinkSync(lockPath);
        createLock();
        return;
      }
      throw new Error('Another process owns the WPPConnect session runtime', {
        cause: error,
      });
    }
  }

  private releaseLock() {
    if (!this.ownsLock) return;
    this.ownsLock = false;
    try {
      unlinkSync(
        join(
          this.config.wppConnectSessionPath,
          `.runtime-${this.config.clientId}.lock`,
        ),
      );
    } catch {
      // The lock may already be gone after an interrupted shutdown.
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string,
  ) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`WPPConnect ${operation} timed out`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export const normalizeWppAck = (ack: AckType) => Number(ack);
