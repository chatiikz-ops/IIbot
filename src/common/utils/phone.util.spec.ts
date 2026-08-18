import { normalizePhone, normalizeWhatsAppPhone } from './phone.util';

describe('Kazakhstan phone normalization', () => {
  it.each([
    ['87051755565', '+77051755565'],
    ['77051755565', '+77051755565'],
    ['+77051755565', '+77051755565'],
    ['8 705 175 55 65', '+77051755565'],
    ['+7 (705) 175-55-65', '+77051755565'],
    ['87764488847 (администратор)', '+77764488847'],
  ])('normalizes %s', (raw, expected) =>
    expect(normalizePhone(raw)).toBe(expected),
  );

  it.each([
    'https://wa.me/77051755565',
    'http://wa.me/77051755565',
    'https://api.whatsapp.com/send?phone=77051755565',
  ])('extracts WhatsApp URL %s', (raw) =>
    expect(normalizeWhatsAppPhone(raw)).toBe('+77051755565'),
  );
});
