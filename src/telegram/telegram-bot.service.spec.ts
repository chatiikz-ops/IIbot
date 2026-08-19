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

  it('respects Telegram 429 retry_after', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        status: 429,
        json: () =>
          Promise.resolve({
            ok: false,
            error_code: 429,
            parameters: { retry_after: 3 },
          }),
      } as Response)
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ ok: true, result: { message_id: 44 } }),
      } as Response);
    const service = new TelegramBotService(config as never);
    const sending = service.sendMessage(123n, 'test');
    await jest.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(sending).resolves.toEqual({ message_id: 44, attempts: 2 });
  });

  it('does not retry a permanent Telegram 4xx', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 400,
      json: () =>
        Promise.resolve({
          ok: false,
          error_code: 400,
          description: 'bad request',
        }),
    } as Response);
    const service = new TelegramBotService(config as never);
    await expect(service.sendMessage(123n, 'test')).rejects.toMatchObject({
      errorCode: 400,
      attempts: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
