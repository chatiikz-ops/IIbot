import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { PromptStrategiesModule } from '../prompt-strategies/prompt-strategies.module';
import { AiConfigService } from './ai-config.service';
import { AiController } from './ai.controller';
import { AiDecisionService } from './ai-decision.service';
import { AiPromptBuilderService } from './ai-prompt-builder.service';
import { AiService } from './ai.service';
import { CostCalculatorService } from './cost-calculator.service';
import { ConversationLanguageService } from './conversation-language.service';
import { OpenAiService } from './open-ai.service';

@Module({
  imports: [ConversationsModule, PromptStrategiesModule],
  controllers: [AiController],
  providers: [
    AiConfigService,
    CostCalculatorService,
    AiPromptBuilderService,
    OpenAiService,
    AiDecisionService,
    AiService,
    ConversationLanguageService,
  ],
  exports: [
    AiService,
    AiConfigService,
    CostCalculatorService,
    ConversationLanguageService,
  ],
})
export class AiModule {}
