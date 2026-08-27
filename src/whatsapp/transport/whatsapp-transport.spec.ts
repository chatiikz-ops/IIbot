import { selectWhatsAppTransport } from './whatsapp-transport';

describe('WhatsApp transport selection', () => {
  it('keeps whatsapp-webjs as the safe default', () => {
    const webjs = { name: 'webjs' };
    expect(
      selectWhatsAppTransport('whatsapp-webjs', webjs, { name: 'wpp' }),
    ).toBe(webjs);
  });

  it('selects WPPConnect only when explicitly enabled', () => {
    const wppconnect = { name: 'wpp' };
    expect(
      selectWhatsAppTransport('wppconnect', { name: 'webjs' }, wppconnect),
    ).toBe(wppconnect);
  });
});
