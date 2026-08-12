import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramModule } from '../telegram/telegram.module';
import { AudioTranscriptionService } from './audio-transcription.service';
import { ImageUnderstandingService } from './image-understanding.service';
import { MediaConfigService } from './media-config.service';
import { MediaController } from './media.controller';
import { MediaProcessingService } from './media-processing.service';
import { MediaService } from './media.service';

@Module({
  imports: [PrismaModule, AiModule, TelegramModule],
  controllers: [MediaController],
  providers: [
    MediaConfigService,
    AudioTranscriptionService,
    ImageUnderstandingService,
    MediaProcessingService,
    MediaService,
  ],
  exports: [MediaProcessingService],
})
export class MediaModule {}
