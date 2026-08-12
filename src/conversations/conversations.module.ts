import { Module } from '@nestjs/common';
import { PromptStrategiesModule } from '../prompt-strategies/prompt-strategies.module';
import { ConversationContextService } from './conversation-context.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  imports: [PromptStrategiesModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, ConversationContextService],
  exports: [ConversationsService, ConversationContextService],
})
export class ConversationsModule {}
