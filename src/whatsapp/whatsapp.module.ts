import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MediaModule } from '../media/media.module';
import { WhatsAppClientService } from './whatsapp-client.service';
import { WhatsAppConfigService } from './whatsapp-config.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppMessagingService } from './whatsapp-messaging.service';

@Module({
  imports: [PrismaModule, MediaModule],
  controllers: [WhatsAppController],
  providers: [
    WhatsAppConfigService,
    WhatsAppClientService,
    WhatsAppMessagingService,
  ],
  exports: [WhatsAppClientService, WhatsAppMessagingService],
})
export class WhatsAppModule {}
