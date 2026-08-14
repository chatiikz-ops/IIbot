import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { SendContactWhatsAppMessageDto } from './dto/send-contact-whatsapp-message.dto';
import { SendWhatsAppMessageDto } from './dto/send-whatsapp-message.dto';
import { WhatsAppMessagesQueryDto } from './dto/whatsapp-messages-query.dto';
import { WhatsAppUnmatchedQueryDto } from './dto/whatsapp-unmatched-query.dto';
import { WhatsAppClientService } from './whatsapp-client.service';
import { WhatsAppMessagingService } from './whatsapp-messaging.service';
import { Roles } from '../auth/auth.decorators';
import { AdminRole } from '../generated/prisma/enums';

@Controller('whatsapp')
export class WhatsAppController {
  constructor(
    private readonly client: WhatsAppClientService,
    private readonly messaging: WhatsAppMessagingService,
  ) {}

  @Get('status')
  status() {
    return this.client.getStatus();
  }

  @Get('qr')
  qr() {
    return this.client.getQr();
  }

  @Post('initialize')
  @Roles(AdminRole.OWNER)
  async initialize() {
    void this.client.initialize().catch(() => undefined);
    return this.client.getStatus();
  }

  @Post('reconnect')
  @Roles(AdminRole.OWNER)
  async reconnect() {
    void this.client.reconnect().catch(() => undefined);
    return this.client.getStatus();
  }

  @Post('destroy')
  @Roles(AdminRole.OWNER)
  destroy() {
    return this.client.destroy();
  }

  @Post('logout')
  @Roles(AdminRole.OWNER)
  logout() {
    return this.client.logout();
  }

  @Post('messages/send')
  send(@Body() data: SendWhatsAppMessageDto) {
    return this.messaging.send(data);
  }

  @Post('contacts/:contactId/send')
  sendToContact(
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() data: SendContactWhatsAppMessageDto,
  ) {
    return this.messaging.sendToContact(contactId, data);
  }

  @Get('messages')
  messages(@Query() query: WhatsAppMessagesQueryDto) {
    return this.messaging.findAll(query);
  }

  @Get('messages/:id')
  message(@Param('id', ParseUUIDPipe) id: string) {
    return this.messaging.findOne(id);
  }

  @Get('unmatched')
  unmatched(@Query() query: WhatsAppUnmatchedQueryDto) {
    return this.messaging.findUnmatched(query);
  }
}
