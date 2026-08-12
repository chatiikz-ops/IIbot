import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { TelegramRecipientStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateTelegramRecipientDto } from './dto/telegram.dto';
import {
  TelegramBotService,
  type TelegramUpdate,
} from './telegram-bot.service';
import { TelegramConfigService } from './telegram-config.service';

@Injectable()
export class TelegramRecipientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TelegramConfigService,
    private readonly bot: TelegramBotService,
  ) {
    this.bot.onUpdate((update) => this.handleUpdate(update));
  }

  async create(data: CreateTelegramRecipientDto) {
    const primaryExists = await this.prisma.telegramRecipient.count({
      where: { isPrimary: true },
    });
    const recipient = await this.prisma.telegramRecipient.create({
      data: { name: data.name.trim(), isPrimary: primaryExists === 0 },
    });
    return this.issueToken(recipient.id);
  }

  async reconnect(id: string) {
    await this.require(id);
    await this.prisma.telegramRecipient.update({
      where: { id },
      data: { status: TelegramRecipientStatus.PENDING, isActive: true },
    });
    return this.issueToken(id);
  }

  async disable(id: string) {
    await this.require(id);
    const item = await this.prisma.telegramRecipient.update({
      where: { id },
      data: {
        status: TelegramRecipientStatus.DISABLED,
        isActive: false,
        linkTokenHash: null,
        linkTokenExpiresAt: null,
      },
    });
    return this.safe(item);
  }

  async findAll() {
    const data = await this.prisma.telegramRecipient.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return data.map((item) => this.safe(item));
  }

  async findOne(id: string) {
    return this.safe(await this.require(id));
  }

  async test(id: string) {
    const recipient = await this.requireConnected(id);
    await this.bot.sendMessage(
      recipient.telegramChatId!,
      '✅ Тестовое уведомление\n\nZapis.kz AI Sales Assistant успешно подключён к Telegram.',
    );
    return { sent: true };
  }

  private async issueToken(id: string) {
    if (!this.config.username)
      throw new BadRequestException('Telegram bot не настроен');
    const raw = randomBytes(24).toString('base64url');
    const recipient = await this.prisma.telegramRecipient.update({
      where: { id },
      data: {
        linkTokenHash: this.hash(raw),
        linkTokenExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    return {
      recipient: this.safe(recipient),
      connectUrl: `https://t.me/${this.config.username}?start=${raw}`,
    };
  }

  private async handleUpdate(update: TelegramUpdate) {
    const message = update.message;
    if (!message?.text || !message.from) return;
    const [command, token] = message.text.trim().split(/\s+/, 2);
    if (command === '/start' && token) {
      const recipient = await this.prisma.telegramRecipient.findUnique({
        where: { linkTokenHash: this.hash(token) },
      });
      if (
        !recipient ||
        !recipient.linkTokenExpiresAt ||
        recipient.linkTokenExpiresAt <= new Date() ||
        recipient.status !== TelegramRecipientStatus.PENDING
      ) {
        await this.bot.sendMessage(
          BigInt(message.chat.id),
          'Ссылка подключения недействительна или истекла.',
        );
        return;
      }
      await this.prisma.telegramRecipient.update({
        where: { id: recipient.id },
        data: {
          telegramUserId: BigInt(message.from.id),
          telegramChatId: BigInt(message.chat.id),
          telegramUsername: message.from.username,
          telegramFirstName: message.from.first_name,
          telegramLastName: message.from.last_name,
          status: TelegramRecipientStatus.CONNECTED,
          connectedAt: new Date(),
          linkTokenHash: null,
          linkTokenExpiresAt: null,
          isActive: true,
        },
      });
      await this.bot.sendMessage(
        BigInt(message.chat.id),
        'Zapis.kz AI Sales Assistant подключён.\n\nВы будете получать здесь служебные уведомления системы.',
      );
      return;
    }
    if (command === '/status') {
      const recipient = await this.prisma.telegramRecipient.findFirst({
        where: {
          telegramChatId: BigInt(message.chat.id),
          status: TelegramRecipientStatus.CONNECTED,
        },
      });
      await this.bot.sendMessage(
        BigInt(message.chat.id),
        `Zapis.kz AI Sales Assistant\nСтатус: ${recipient ? 'подключён' : 'не подключён'}\nУведомления: ${recipient?.isActive ? 'включены' : 'выключены'}`,
      );
      return;
    }
    if (command === '/help') {
      await this.bot.sendMessage(
        BigInt(message.chat.id),
        'Бот отправляет служебные уведомления менеджерам Zapis.kz. Управление клиентскими диалогами здесь недоступно.',
      );
      return;
    }
    if (command === '/start') {
      await this.bot.sendMessage(
        BigInt(message.chat.id),
        'Подключение выполняется из панели Zapis.kz AI Sales.',
      );
    }
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private async require(id: string) {
    const item = await this.prisma.telegramRecipient.findUnique({
      where: { id },
    });
    if (!item) throw new NotFoundException('Получатель Telegram не найден');
    return item;
  }

  private async requireConnected(id: string) {
    const item = await this.require(id);
    if (
      item.status !== TelegramRecipientStatus.CONNECTED ||
      !item.telegramChatId ||
      !item.isActive
    )
      throw new BadRequestException('Получатель Telegram не подключён');
    return item;
  }

  private safe<
    T extends {
      telegramUserId: bigint | null;
      telegramChatId: bigint | null;
      linkTokenHash: string | null;
    },
  >(
    item: T,
  ): Omit<T, 'telegramUserId' | 'telegramChatId' | 'linkTokenHash'> & {
    telegramUserId: string | null;
    telegramChatId: string | null;
  } {
    const {
      linkTokenHash: _linkTokenHash,
      telegramUserId,
      telegramChatId,
      ...safe
    } = item;
    void _linkTokenHash;
    return {
      ...safe,
      telegramUserId: telegramUserId?.toString() ?? null,
      telegramChatId: telegramChatId?.toString() ?? null,
    };
  }
}
