import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MessageAck, type Message as WebMessage } from 'whatsapp-web.js';
import { normalizePhone } from '../common/utils/phone.util';
import { Prisma } from '../generated/prisma/client';
import {
  ConversationStatus,
  MessageRole,
  MediaType,
  WhatsAppMessageDirection,
  WhatsAppMessageStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { MediaProcessingService } from '../media/media-processing.service';
import type { SendContactWhatsAppMessageDto } from './dto/send-contact-whatsapp-message.dto';
import type { SendWhatsAppMessageDto } from './dto/send-whatsapp-message.dto';
import type { WhatsAppMessagesQueryDto } from './dto/whatsapp-messages-query.dto';
import type { WhatsAppUnmatchedQueryDto } from './dto/whatsapp-unmatched-query.dto';
import { WhatsAppClientService } from './whatsapp-client.service';

const ACTIVE_CONVERSATION_STATUSES = [
  ConversationStatus.NEW,
  ConversationStatus.ACTIVE,
  ConversationStatus.WAITING_CLIENT,
  ConversationStatus.HANDOFF_REQUIRED,
];

export type KnownInboundMessage = {
  contactId: string;
  conversationId: string;
  messageId: string;
  whatsAppMessageId: string;
};

export type SendAiMessageInput = {
  contactId: string;
  conversationId: string;
  messageId: string;
  phone: string;
  text: string;
};

@Injectable()
export class WhatsAppMessagingService {
  private readonly logger = new Logger(WhatsAppMessagingService.name);
  private readonly knownInboundHandlers: Array<
    (message: KnownInboundMessage) => Promise<void>
  > = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: WhatsAppClientService,
    private readonly media: MediaProcessingService,
  ) {
    this.client.onMessage((message) => this.handleInbound(message));
    this.client.onAck((message, ack) => this.handleAck(message, ack));
  }

  onKnownInbound(handler: (message: KnownInboundMessage) => Promise<void>) {
    this.knownInboundHandlers.push(handler);
  }

  async sendAiMessage(data: SendAiMessageInput) {
    const existing = await this.prisma.whatsAppMessage.findUnique({
      where: { messageId: data.messageId },
    });
    if (existing) {
      return { whatsappMessage: this.safeMessage(existing), alreadySent: true };
    }

    const message = await this.prisma.message.findFirst({
      where: {
        id: data.messageId,
        conversationId: data.conversationId,
        role: MessageRole.AI,
      },
    });
    if (!message) throw new NotFoundException('AI-сообщение не найдено');
    const contact = await this.prisma.contact.findUnique({
      where: { id: data.contactId },
      select: { id: true },
    });
    if (!contact) throw new NotFoundException('Контакт не найден');

    const phone = this.requirePhone(data.phone);
    const chatId = this.toChatId(phone);
    await this.ensureRegistered(chatId);

    let pending: { id: string };
    try {
      pending = await this.prisma.whatsAppMessage.create({
        data: {
          direction: WhatsAppMessageDirection.OUTBOUND,
          status: WhatsAppMessageStatus.PENDING,
          phone,
          text: data.text,
          contactId: data.contactId,
          conversationId: data.conversationId,
          messageId: data.messageId,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const duplicate = await this.prisma.whatsAppMessage.findUniqueOrThrow({
          where: { messageId: data.messageId },
        });
        return {
          whatsappMessage: this.safeMessage(duplicate),
          alreadySent: true,
        };
      }
      throw error;
    }

    try {
      const sent = await this.client.sendText(chatId, data.text);
      const externalMessageId = WhatsAppClientService.externalMessageId(sent);
      const whatsappMessage = await this.prisma.whatsAppMessage.update({
        where: { id: pending.id },
        data: {
          externalMessageId,
          status: WhatsAppMessageStatus.SENT,
          sentAt: new Date(),
        },
      });
      return {
        whatsappMessage: this.safeMessage(whatsappMessage),
        alreadySent: false,
      };
    } catch {
      await this.markFailed(pending.id);
      throw new BadGatewayException('Не удалось отправить ответ в WhatsApp');
    }
  }

  async send(data: SendWhatsAppMessageDto) {
    const phone = this.requirePhone(data.phone);
    const chatId = this.toChatId(phone);
    await this.ensureRegistered(chatId);
    const record = await this.prisma.whatsAppMessage.create({
      data: {
        direction: WhatsAppMessageDirection.OUTBOUND,
        status: WhatsAppMessageStatus.PENDING,
        phone,
        text: data.text,
      },
    });
    try {
      const sent = await this.client.sendText(chatId, data.text);
      const externalMessageId = WhatsAppClientService.externalMessageId(sent);
      const updated = await this.prisma.whatsAppMessage.update({
        where: { id: record.id },
        data: {
          externalMessageId,
          status: WhatsAppMessageStatus.SENT,
          sentAt: new Date(),
        },
      });
      this.logger.log(
        `Outbound WhatsApp message sent (${this.shortId(externalMessageId)})`,
      );
      return this.safeMessage(updated);
    } catch {
      await this.markFailed(record.id);
      throw new BadGatewayException(
        'Не удалось отправить сообщение в WhatsApp',
      );
    }
  }

  async sendToContact(contactId: string, data: SendContactWhatsAppMessageDto) {
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
    });
    if (!contact) throw new NotFoundException('Контакт не найден');
    if (!contact.outreachEligible) {
      throw new ForbiddenException(
        'Контакт исключён из автоматической обработки',
      );
    }
    const phone = this.requirePhone(contact.phone);
    const chatId = this.toChatId(phone);
    await this.ensureRegistered(chatId);

    const prepared = await this.prisma.$transaction(async (tx) => {
      const conversation = await this.findOrCreateConversation(
        tx,
        contact.id,
        contact.strategyCode,
      );
      const whatsappMessage = await tx.whatsAppMessage.create({
        data: {
          direction: WhatsAppMessageDirection.OUTBOUND,
          status: WhatsAppMessageStatus.PENDING,
          phone,
          text: data.text,
          contactId: contact.id,
          conversationId: conversation.id,
        },
      });
      return { conversation, whatsappMessage };
    });

    try {
      const sent = await this.client.sendText(chatId, data.text);
      const externalMessageId = WhatsAppClientService.externalMessageId(sent);
      const result = await this.prisma.$transaction(async (tx) => {
        const message = await tx.message.create({
          data: {
            conversationId: prepared.conversation.id,
            role: MessageRole.MANAGER,
            text: data.text,
          },
        });
        await tx.conversation.update({
          where: { id: prepared.conversation.id },
          data: {
            status: ConversationStatus.WAITING_CLIENT,
            lastMessageAt: message.createdAt,
            messageCount: { increment: 1 },
          },
        });
        const whatsappMessage = await tx.whatsAppMessage.update({
          where: { id: prepared.whatsappMessage.id },
          data: {
            messageId: message.id,
            externalMessageId,
            status: WhatsAppMessageStatus.SENT,
            sentAt: new Date(),
          },
        });
        return {
          whatsappMessage,
          message,
          conversationId: prepared.conversation.id,
        };
      });
      this.logger.log(
        `Contact WhatsApp message sent (${this.shortId(externalMessageId)})`,
      );
      return {
        whatsappMessage: this.safeMessage(result.whatsappMessage),
        message: result.message,
        conversationId: result.conversationId,
      };
    } catch {
      await this.markFailed(prepared.whatsappMessage.id);
      throw new BadGatewayException(
        'Не удалось отправить сообщение в WhatsApp',
      );
    }
  }

  async findAll(query: WhatsAppMessagesQueryDto) {
    const where: Prisma.WhatsAppMessageWhereInput = {
      direction: query.direction,
      status: query.status,
      ...(query.phone ? { phone: { contains: query.phone } } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.whatsAppMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.whatsAppMessage.count({ where }),
    ]);
    return {
      data: data.map((item) => this.safeMessage(item)),
      meta: this.meta(total, query.page, query.limit),
    };
  }

  async findOne(id: string) {
    const message = await this.prisma.whatsAppMessage.findUnique({
      where: { id },
    });
    if (!message) throw new NotFoundException('WhatsApp-сообщение не найдено');
    return this.safeMessage(message);
  }

  findByMessageId(messageId: string) {
    return this.prisma.whatsAppMessage.findUnique({ where: { messageId } });
  }

  async findUnmatched(query: WhatsAppUnmatchedQueryDto) {
    const where: Prisma.WhatsAppMessageWhereInput = {
      direction: WhatsAppMessageDirection.INBOUND,
      contactId: null,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.whatsAppMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.whatsAppMessage.count({ where }),
    ]);
    return {
      data: data.map((item) => this.safeMessage(item)),
      meta: this.meta(total, query.page, query.limit),
    };
  }

  async handleInbound(message: WebMessage) {
    if (!WhatsAppClientService.isEligibleInbound(message)) return;
    if (message.hasMedia) {
      await this.handleMediaInbound(message);
      return;
    }
    if (!WhatsAppClientService.isSupportedInbound(message)) return;
    const externalMessageId = WhatsAppClientService.externalMessageId(message);
    if (!externalMessageId) return;
    const phone = this.fromChatId(message.from);
    if (!phone) return;

    try {
      const stored = await this.prisma.$transaction(async (tx) => {
        const contact = await tx.contact.findUnique({ where: { phone } });
        if (!contact) {
          return tx.whatsAppMessage.create({
            data: {
              externalMessageId,
              direction: WhatsAppMessageDirection.INBOUND,
              status: WhatsAppMessageStatus.RECEIVED,
              phone,
              text: message.body.trim(),
              receivedAt: this.messageDate(message),
            },
          });
        }

        const conversation = await this.findOrCreateConversation(
          tx,
          contact.id,
          contact.strategyCode,
        );
        const localMessage = await tx.message.create({
          data: {
            conversationId: conversation.id,
            role: MessageRole.CLIENT,
            text: message.body.trim(),
          },
        });
        const nextStatus =
          conversation.status === ConversationStatus.HANDOFF_REQUIRED
            ? ConversationStatus.HANDOFF_REQUIRED
            : ConversationStatus.ACTIVE;
        await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            status: nextStatus,
            lastMessageAt: localMessage.createdAt,
            messageCount: { increment: 1 },
          },
        });
        return tx.whatsAppMessage.create({
          data: {
            externalMessageId,
            direction: WhatsAppMessageDirection.INBOUND,
            status: WhatsAppMessageStatus.RECEIVED,
            phone,
            text: message.body.trim(),
            contactId: contact.id,
            conversationId: conversation.id,
            messageId: localMessage.id,
            receivedAt: this.messageDate(message),
          },
        });
      });
      this.logger.log(
        `Inbound WhatsApp message stored (${this.shortId(stored.externalMessageId)})`,
      );
      if (stored.contactId && stored.conversationId && stored.messageId) {
        const payload: KnownInboundMessage = {
          contactId: stored.contactId,
          conversationId: stored.conversationId,
          messageId: stored.messageId,
          whatsAppMessageId: stored.id,
        };
        for (const handler of this.knownInboundHandlers) {
          void handler(payload).catch(() =>
            this.logger.error(
              `Inbound automation callback failed (${this.shortId(stored.externalMessageId)})`,
            ),
          );
        }
      }
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return;
      }
      throw error;
    }
  }

  private async handleMediaInbound(message: WebMessage) {
    const externalMessageId = WhatsAppClientService.externalMessageId(message);
    if (!externalMessageId) return;
    const phone = this.fromChatId(message.from);
    if (!phone) return;
    try {
      const stored = await this.prisma.$transaction(async (tx) => {
        const contact = await tx.contact.findUnique({ where: { phone } });
        const conversation = contact
          ? await this.findOrCreateConversation(
              tx,
              contact.id,
              contact.strategyCode,
            )
          : null;
        return tx.whatsAppMessage.create({
          data: {
            externalMessageId,
            direction: WhatsAppMessageDirection.INBOUND,
            status: WhatsAppMessageStatus.RECEIVED,
            phone,
            text: message.body?.trim() || '',
            contactId: contact?.id,
            conversationId: conversation?.id,
            receivedAt: this.messageDate(message),
          },
        });
      });
      const type = this.mediaType(message.type);
      if (!type) {
        await this.media.recordUnsupported({
          contactId: stored.contactId,
          conversationId: stored.conversationId,
          whatsAppMessageId: stored.id,
        });
        return;
      }
      await this.media.process({
        whatsAppMessageId: stored.id,
        contactId: stored.contactId,
        conversationId: stored.conversationId,
        type,
        caption: message.body?.trim() || undefined,
        download: () => message.downloadMedia(),
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return;
      }
      throw error;
    }
  }

  private mediaType(messageType: string) {
    if (messageType === 'ptt') return MediaType.VOICE;
    if (messageType === 'audio') return MediaType.AUDIO;
    if (messageType === 'image') return MediaType.IMAGE;
    return null;
  }

  async handleAck(message: WebMessage, ack: MessageAck) {
    const externalMessageId = WhatsAppClientService.externalMessageId(message);
    const status = WhatsAppClientService.ackStatus(ack);
    if (!externalMessageId || !status) return;
    await this.prisma.whatsAppMessage.updateMany({
      where: { externalMessageId },
      data: {
        status,
        ...(status === WhatsAppMessageStatus.FAILED
          ? { errorMessage: 'WhatsApp delivery failed' }
          : {}),
      },
    });
  }

  private async findOrCreateConversation(
    tx: Prisma.TransactionClient,
    contactId: string,
    strategyCode: string | null,
  ) {
    const existing = await tx.conversation.findFirst({
      where: { contactId, status: { in: ACTIVE_CONVERSATION_STATUSES } },
      orderBy: { startedAt: 'desc' },
    });
    if (existing) return existing;
    return tx.conversation.create({
      data: {
        contactId,
        strategyCode: strategyCode ?? 'MANUAL_WHATSAPP',
      },
    });
  }

  private requirePhone(value: string) {
    const phone = normalizePhone(value);
    if (!phone) throw new BadRequestException('Некорректный номер телефона');
    return phone;
  }

  private toChatId(phone: string) {
    return `${phone.slice(1)}@c.us`;
  }

  private fromChatId(chatId: string) {
    const digits = chatId.split('@')[0]?.replace(/\D/g, '') ?? '';
    const normalized = normalizePhone(digits);
    if (normalized) return normalized;
    return /^\d{7,15}$/.test(digits) ? `+${digits}` : null;
  }

  private async ensureRegistered(chatId: string) {
    if (!(await this.client.isRegisteredUser(chatId))) {
      throw new BadRequestException('Номер не зарегистрирован в WhatsApp');
    }
  }

  private async markFailed(id: string) {
    await this.prisma.whatsAppMessage.update({
      where: { id },
      data: {
        status: WhatsAppMessageStatus.FAILED,
        errorMessage: 'WhatsApp send failed',
      },
    });
  }

  private messageDate(message: WebMessage) {
    const value = new Date(message.timestamp * 1000);
    return Number.isNaN(value.getTime()) ? new Date() : value;
  }

  private shortId(value: string | null) {
    return value ? value.slice(-8) : 'no-id';
  }

  private safeMessage<T extends { [key: string]: unknown }>(message: T) {
    return message;
  }

  private meta(total: number, page: number, limit: number) {
    return { page, limit, total, totalPages: Math.ceil(total / limit) };
  }
}
