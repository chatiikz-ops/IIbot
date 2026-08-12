import { Injectable } from '@nestjs/common';
import OpenAI, { toFile } from 'openai';
import { AiConfigService } from '../ai/ai-config.service';
import { MediaConfigService } from './media-config.service';
import { MediaProviderError } from './media-provider-error';

export type AudioTranscriptionResult = {
  text: string;
  model: string;
  responseId: string | null;
  durationMs: number;
};

@Injectable()
export class AudioTranscriptionService {
  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly mediaConfig: MediaConfigService,
  ) {}

  async transcribe(buffer: Buffer, filename: string, mimeType: string) {
    if (this.aiConfig.mockMode) {
      return {
        text: 'Здравствуйте, у нас 12 мастеров, сейчас используем Altegio.',
        model: 'mock-transcription',
        responseId: 'mock-audio',
        durationMs: 1,
      } satisfies AudioTranscriptionResult;
    }
    const client = new OpenAI({
      apiKey: this.aiConfig.apiKey!,
      timeout: this.mediaConfig.audioTimeoutMs,
      maxRetries: 0,
    });
    return this.withRetry(async () => {
      const startedAt = Date.now();
      const result = await client.audio.transcriptions.create({
        file: await toFile(buffer, filename, { type: mimeType }),
        model: this.mediaConfig.transcriptionModel,
        response_format: 'json',
      });
      const text = result.text.trim();
      if (!text) throw new MediaProviderError('EMPTY_TRANSCRIPTION', false);
      return {
        text,
        model: this.mediaConfig.transcriptionModel,
        responseId: null,
        durationMs: Date.now() - startedAt,
      } satisfies AudioTranscriptionResult;
    });
  }

  private async withRetry<T>(operation: () => Promise<T>) {
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const mapped = this.mapError(error);
        if (!mapped.retryable || attempt === 2) throw mapped;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
    throw new MediaProviderError('TRANSCRIPTION_FAILED', false);
  }

  private mapError(error: unknown) {
    if (error instanceof MediaProviderError) return error;
    if (
      error instanceof OpenAI.APIConnectionTimeoutError ||
      error instanceof OpenAI.APIConnectionError
    ) {
      return new MediaProviderError('OPENAI_NETWORK_ERROR', true);
    }
    if (error instanceof OpenAI.APIError) {
      return new MediaProviderError(
        'OPENAI_API_ERROR',
        error.status === 429 || (error.status ?? 0) >= 500,
      );
    }
    return new MediaProviderError('TRANSCRIPTION_FAILED', false);
  }
}
