import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AiModule } from './ai/ai.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { ContactsModule } from './contacts/contacts.module';
import { ClassificationModule } from './classification/classification.module';
import { ConversationsModule } from './conversations/conversations.module';
import { ImportsModule } from './imports/imports.module';
import { LeadsModule } from './leads/leads.module';
import { MessagesModule } from './messages/messages.module';
import { MediaModule } from './media/media.module';
import { PrismaModule } from './prisma/prisma.module';
import { PromptStrategiesModule } from './prompt-strategies/prompt-strategies.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { TelegramModule } from './telegram/telegram.module';
import { AutomationModule } from './automation/automation.module';

@Module({
  imports: [
    PrismaModule,
    ContactsModule,
    ImportsModule,
    ClassificationModule,
    PromptStrategiesModule,
    ConversationsModule,
    MessagesModule,
    MediaModule,
    LeadsModule,
    AiModule,
    CampaignsModule,
    WhatsAppModule,
    TelegramModule,
    AutomationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
