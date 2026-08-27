import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MediaModule } from '../media/media.module';
import { WhatsAppClientService } from './whatsapp-client.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppMessagingService } from './whatsapp-messaging.service';
import {
  selectWhatsAppTransport,
  WHATSAPP_TRANSPORT,
} from './transport/whatsapp-transport';
import { WppConnectTransport } from './transport/wppconnect.transport';
import { WhatsAppWebJsTransport } from './transport/whatsapp-webjs.transport';
import { WhatsAppConfigService } from './whatsapp-config.service';

@Module({
  imports: [PrismaModule, MediaModule],
  controllers: [WhatsAppController],
  providers: [
    WhatsAppConfigService,
    WhatsAppClientService,
    WppConnectTransport,
    {
      provide: WHATSAPP_TRANSPORT,
      inject: [
        WhatsAppConfigService,
        WhatsAppWebJsTransport,
        WppConnectTransport,
      ],
      useFactory: (
        config: WhatsAppConfigService,
        webjs: WhatsAppWebJsTransport,
        wppconnect: WppConnectTransport,
      ) => selectWhatsAppTransport(config.transport, webjs, wppconnect),
    },
    WhatsAppMessagingService,
  ],
  exports: [
    WHATSAPP_TRANSPORT,
    WhatsAppClientService,
    WhatsAppMessagingService,
  ],
})
export class WhatsAppModule {}
