import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateTelegramRecipientDto,
  TelegramNotificationsQueryDto,
  UpdateTelegramSettingsDto,
} from './dto/telegram.dto';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramConfigService } from './telegram-config.service';
import { TelegramNotificationsService } from './telegram-notifications.service';
import { TelegramRecipientsService } from './telegram-recipients.service';
import { TelegramSettingsService } from './telegram-settings.service';

@Controller('telegram')
export class TelegramController {
  constructor(
    private readonly config: TelegramConfigService,
    private readonly bot: TelegramBotService,
    private readonly recipients: TelegramRecipientsService,
    private readonly settings: TelegramSettingsService,
    private readonly notifications: TelegramNotificationsService,
  ) {}

  @Get('status') async status() {
    const connectedRecipients = await this.recipients
      .findAll()
      .then((items) =>
        items.filter((item) => item.status === 'CONNECTED' && item.isActive),
      );
    let botReachable = false;
    if (this.config.enabled && this.config.configured)
      botReachable = await this.bot
        .getMe()
        .then(() => true)
        .catch(() => false);
    return {
      enabled: this.config.enabled,
      configured: this.config.configured,
      botReachable,
      connectedRecipients: connectedRecipients.length,
      primaryRecipientConnected: connectedRecipients.some(
        (item) => item.isPrimary,
      ),
    };
  }
  @Post('recipients') create(@Body() data: CreateTelegramRecipientDto) {
    return this.recipients.create(data);
  }
  @Get('recipients') recipientsList() {
    return this.recipients.findAll();
  }
  @Get('recipients/:id') recipient(@Param('id', ParseUUIDPipe) id: string) {
    return this.recipients.findOne(id);
  }
  @Post('recipients/:id/reconnect') reconnect(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.recipients.reconnect(id);
  }
  @Post('recipients/:id/disable') disable(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.recipients.disable(id);
  }
  @Post('recipients/:id/test') test(@Param('id', ParseUUIDPipe) id: string) {
    return this.recipients.test(id);
  }
  @Get('settings') getSettings() {
    return this.settings.get();
  }
  @Patch('settings') updateSettings(@Body() data: UpdateTelegramSettingsDto) {
    return this.settings.update(data);
  }
  @Get('notifications') notificationList(
    @Query() query: TelegramNotificationsQueryDto,
  ) {
    return this.notifications.findAll(query);
  }
  @Get('notifications/:id') notification(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notifications.findOne(id);
  }
}
