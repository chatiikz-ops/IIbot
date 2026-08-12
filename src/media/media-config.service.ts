import { Injectable } from '@nestjs/common';
import { resolve } from 'node:path';

@Injectable()
export class MediaConfigService {
  get enabled() {
    return process.env.MEDIA_PROCESSING_ENABLED?.toLowerCase() !== 'false';
  }

  get maxAudioBytes() {
    return this.positiveNumber('MEDIA_MAX_AUDIO_MB', 20) * 1024 * 1024;
  }

  get maxImageBytes() {
    return this.positiveNumber('MEDIA_MAX_IMAGE_MB', 10) * 1024 * 1024;
  }

  get transcriptionModel() {
    return (
      process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-mini-transcribe'
    );
  }

  get visionModel() {
    return process.env.OPENAI_VISION_MODEL?.trim() || 'gpt-4o';
  }

  get audioTimeoutMs() {
    return this.positiveNumber('MEDIA_AUDIO_TIMEOUT_MS', 60_000);
  }

  get imageTimeoutMs() {
    return this.positiveNumber('MEDIA_IMAGE_TIMEOUT_MS', 60_000);
  }

  get tempPath() {
    return resolve('storage/media/tmp');
  }

  private positiveNumber(name: string, fallback: number) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}
