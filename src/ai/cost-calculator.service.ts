import { Injectable } from '@nestjs/common';
import { AiConfigService } from './ai-config.service';

@Injectable()
export class CostCalculatorService {
  constructor(private readonly config: AiConfigService) {}

  calculate(inputTokens?: number | null, outputTokens?: number | null) {
    const inputPrice = this.config.inputPricePerMillion;
    const outputPrice = this.config.outputPricePerMillion;
    if (inputPrice === null || outputPrice === null) return null;
    return (
      ((inputTokens ?? 0) * inputPrice + (outputTokens ?? 0) * outputPrice) /
      1_000_000
    );
  }
}
