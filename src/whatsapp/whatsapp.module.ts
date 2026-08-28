import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MediaModule } from '../media/media.module';
import { WhatsAppClientService } from './whatsapp-client.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppMessagingService } from './whatsapp-messaging.service';
import {
  createWhatsAppTransportProviders,
  WHATSAPP_TRANSPORT,
} from './transport/whatsapp-transport';
import { WppConnectTransport } from './transport/wppconnect.transport';
import { WhatsAppConfigService } from './whatsapp-config.service';

// The token is an alias, not a factory returning an existing lifecycle owner.
// This ensures Nest sees exactly one non-alias provider with lifecycle hooks.
const selectedTransportProviders = createWhatsAppTransportProviders(
  process.env.WHATSAPP_TRANSPORT,
  WhatsAppClientService,
  WppConnectTransport,
);

@Module({
  imports: [PrismaModule, MediaModule],
  controllers: [WhatsAppController],
  providers: [
    WhatsAppConfigService,
    ...selectedTransportProviders,
    WhatsAppMessagingService,
  ],
  exports: [WHATSAPP_TRANSPORT, WhatsAppMessagingService],
})
export class WhatsAppModule {}
