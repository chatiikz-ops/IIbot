import { WhatsAppConfigService } from './whatsapp-config.service';

describe('WhatsAppConfigService browser launch config', () => {
  const originalExecutablePath = process.env.WHATSAPP_CHROME_EXECUTABLE_PATH;
  const originalHeadless = process.env.WHATSAPP_HEADLESS;

  afterEach(() => {
    if (originalExecutablePath === undefined) {
      delete process.env.WHATSAPP_CHROME_EXECUTABLE_PATH;
    } else {
      process.env.WHATSAPP_CHROME_EXECUTABLE_PATH = originalExecutablePath;
    }
    if (originalHeadless === undefined) {
      delete process.env.WHATSAPP_HEADLESS;
    } else {
      process.env.WHATSAPP_HEADLESS = originalHeadless;
    }
  });

  it('builds the default Puppeteer launch config without random flags', () => {
    delete process.env.WHATSAPP_CHROME_EXECUTABLE_PATH;
    process.env.WHATSAPP_HEADLESS = 'true';

    expect(new WhatsAppConfigService().browserLaunchOptions).toEqual({
      headless: true,
      args: [],
    });
  });

  it('uses an existing absolute executablePath from the environment', () => {
    process.env.WHATSAPP_CHROME_EXECUTABLE_PATH = process.execPath;
    process.env.WHATSAPP_HEADLESS = 'false';

    expect(new WhatsAppConfigService().browserLaunchOptions).toEqual({
      headless: false,
      executablePath: process.execPath,
      args: [],
    });
  });

  it('rejects a relative executablePath', () => {
    process.env.WHATSAPP_CHROME_EXECUTABLE_PATH = 'chrome.exe';

    expect(() => new WhatsAppConfigService().browserLaunchOptions).toThrow(
      'WHATSAPP_CHROME_EXECUTABLE_PATH must be absolute',
    );
  });

  it('rejects a missing executablePath', () => {
    process.env.WHATSAPP_CHROME_EXECUTABLE_PATH = `${process.execPath}.missing`;

    expect(() => new WhatsAppConfigService().browserLaunchOptions).toThrow(
      'WHATSAPP_CHROME_EXECUTABLE_PATH does not exist',
    );
  });
});
