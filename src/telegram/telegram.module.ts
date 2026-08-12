import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramConfigService } from './telegram-config.service';
import { TelegramController } from './telegram.controller';
import { TelegramNotificationsService } from './telegram-notifications.service';
import { TelegramRecipientsService } from './telegram-recipients.service';
import { TelegramSettingsService } from './telegram-settings.service';

@Module({
  imports: [PrismaModule],
  controllers: [TelegramController],
  providers: [
    TelegramConfigService,
    TelegramBotService,
    TelegramRecipientsService,
    TelegramSettingsService,
    TelegramNotificationsService,
  ],
  exports: [TelegramNotificationsService],
})
export class TelegramModule {}
