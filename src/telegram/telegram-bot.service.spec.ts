import { TelegramBotService } from './telegram-bot.service';

describe('TelegramBotService delivery retries', () => {
  const config = {
    mockMode: false,
    token: 'test-token',
    timeoutMs: 1000,
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('retries Telegram 5xx with backoff and reports provider attempts', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        status: 500,
        json: () => Promise.resolve({ ok: false, error_code: 500 }),
      } as Response)
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ ok: true, result: { message_id: 42 } }),
      } as Response);
    const service = new TelegramBotService(config as never);

    const sending = service.sendMessage(123n, 'test');
    await jest.advanceTimersByTimeAsync(1000);

    await expect(sending).resolves.toEqual({ message_id: 42, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a transient network error with exponential backoff', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ ok: true, result: { message_id: 43 } }),
      } as Response);
    const service = new TelegramBotService(config as never);

    const sending = service.sendMessage(123n, 'test');
    await jest.advanceTimersByTimeAsync(250);

    await expect(sending).resolves.toEqual({ message_id: 43, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
