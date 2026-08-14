import { AiConfigService } from './ai-config.service';
import { OpenAiService } from './open-ai.service';

const input = [{ role: 'user' as const, content: 'test' }];

describe('OpenAiService latency policy', () => {
  it('performs at most one application retry for a transient timeout', async () => {
    const service = new OpenAiService({
      maxRetries: 1,
      mockMode: true,
    } as AiConfigService);

    await expect(service.generate('', input, 'TIMEOUT')).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
      attempts: 2,
    });
  });

  it('does not retry invalid structured output', async () => {
    const service = new OpenAiService({
      maxRetries: 1,
      mockMode: true,
    } as AiConfigService);

    await expect(
      service.generate('', input, 'INVALID_OUTPUT'),
    ).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
      retryable: false,
      attempts: 1,
    });
  });
});

describe('AiConfigService conversational defaults', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('uses a short timeout, one retry and bounded output', () => {
    delete process.env.OPENAI_TIMEOUT_MS;
    delete process.env.OPENAI_MAX_RETRIES;
    delete process.env.OPENAI_MAX_OUTPUT_TOKENS;
    delete process.env.OPENAI_REASONING_EFFORT;

    const config = new AiConfigService();
    expect(config.timeoutMs).toBe(25_000);
    expect(config.maxRetries).toBe(1);
    expect(config.maxOutputTokens).toBe(600);
    expect(config.reasoningEffort).toBe('minimal');
  });
});
