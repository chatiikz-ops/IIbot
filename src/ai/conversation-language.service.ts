import { Injectable } from '@nestjs/common';
import { MessageRole } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

const SHORT =
  /^(ok|okay|ок|да|нет|иә|ия|жоқ|\+|понятно|түсінікті|👍)[.!?\s]*$/iu;

@Injectable()
export class ConversationLanguageService {
  constructor(private readonly prisma: PrismaService) {}

  async updateFromClientMessage(conversationId: string, text: string) {
    const preferredLanguage = this.detect(text);
    if (!preferredLanguage) return null;
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { preferredLanguage },
    });
    return preferredLanguage;
  }

  async resolve(conversationId: string) {
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        preferredLanguage: true,
        messages: {
          where: { role: MessageRole.CLIENT },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { text: true },
        },
      },
    });
    for (const message of conversation.messages) {
      const language = this.detect(message.text);
      if (language) return language;
    }
    return conversation.preferredLanguage;
  }

  detect(text: string): string | null {
    const value = text.trim();
    if (!value || SHORT.test(value)) return null;
    if (/қазақша|қазақ тіл|kazakh/i.test(value)) return 'kk';
    if (/по-?русски|русском язык|russian/i.test(value)) return 'ru';
    if (/in english|english please|английском/i.test(value)) return 'en';
    const kazakh = (value.match(/[әғқңөұүһі]/giu) ?? []).length;
    const cyrillic = (value.match(/[а-яё]/giu) ?? []).length;
    const latin = (value.match(/[a-z]/giu) ?? []).length;
    if (kazakh >= 1 && cyrillic >= 4) return 'kk';
    if (latin >= 6 && latin > cyrillic * 1.5) return 'en';
    if (cyrillic >= 5) return 'ru';
    return null;
  }
}
