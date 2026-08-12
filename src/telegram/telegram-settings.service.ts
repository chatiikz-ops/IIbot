import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateTelegramSettingsDto } from './dto/telegram.dto';

@Injectable()
export class TelegramSettingsService {
  constructor(private readonly prisma: PrismaService) {}
  get() {
    return this.prisma.telegramNotificationSettings.upsert({
      where: { singletonKey: 'global' },
      create: { singletonKey: 'global' },
      update: {},
    });
  }
  update(data: UpdateTelegramSettingsDto) {
    return this.prisma.telegramNotificationSettings.upsert({
      where: { singletonKey: 'global' },
      create: { singletonKey: 'global', ...data },
      update: data,
    });
  }
}
