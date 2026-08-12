import { Module } from '@nestjs/common';
import { PromptStrategiesController } from './prompt-strategies.controller';
import { PromptStrategiesService } from './prompt-strategies.service';

@Module({
  controllers: [PromptStrategiesController],
  providers: [PromptStrategiesService],
  exports: [PromptStrategiesService],
})
export class PromptStrategiesModule {}
