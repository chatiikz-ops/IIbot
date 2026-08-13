import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { ContactsModule } from '../contacts/contacts.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { MessagesModule } from '../messages/messages.module';
import { MediaModule } from '../media/media.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PromptStrategiesModule } from '../prompt-strategies/prompt-strategies.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { TelegramModule } from '../telegram/telegram.module';
import { AutomationController } from './automation.controller';
import { AutomationDelayService } from './automation-delay.service';
import { AutomationEventsService } from './automation-events.service';
import { AutomationSettingsService } from './automation-settings.service';
import { ConversationOrchestratorService } from './conversation-orchestrator.service';
import { AutomationWorkerService } from './automation-worker.service';

@Module({
  imports: [
    PrismaModule,
    ContactsModule,
    ConversationsModule,
    MessagesModule,
    MediaModule,
    PromptStrategiesModule,
    AiModule,
    WhatsAppModule,
    CampaignsModule,
    TelegramModule,
  ],
  controllers: [AutomationController],
  providers: [
    AutomationSettingsService,
    AutomationEventsService,
    AutomationDelayService,
    ConversationOrchestratorService,
    AutomationWorkerService,
  ],
  exports: [ConversationOrchestratorService, AutomationSettingsService],
})
export class AutomationModule {}
