import { ImportsService } from './imports.service';
import type { ColumnMapping, RawImportRow } from './imports.types';

jest.mock('../generated/prisma/client', () => ({ Prisma: { DbNull: null } }));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

describe('ImportsService 2GIS normalization', () => {
  const prisma = { contact: { findMany: jest.fn().mockResolvedValue([]) } };
  const service = new ImportsService(prisma as never, {} as never);
  const mapping: ColumnMapping = {
    Наименование: 'companyName',
    Рубрики: 'category',
    'Телефон 1': 'phone',
    'Телефон 2': 'phone',
    'Веб-сайт 1': 'website',
    'WhatsApp 1': 'whatsapp',
  };

  function normalize(rawData: RawImportRow) {
    return (
      service as unknown as {
        normalizeRow(
          row: { rowNumber: number; rawData: RawImportRow },
          mapping: ColumnMapping,
        ): Record<string, unknown>;
      }
    ).normalizeRow({ rowNumber: 2, rawData }, mapping);
  }

  it.each([
    [
      'Aq Saqal',
      '87051755565',
      'https://wa.me/77051755565',
      '+77051755565',
      'PHONE',
    ],
    [
      'Barbershop DOSS',
      '87764488847 (администратор)',
      'https://wa.me/77764488847',
      '+77764488847',
      'PHONE',
    ],
    [
      'Chistobarber',
      null,
      'https://wa.me/77000804511',
      '+77000804511',
      'WHATSAPP',
    ],
  ])(
    'normalizes the real 2GIS row %s',
    (companyName, rawPhone, rawWhatsapp, phone, phoneSource) => {
      const result = normalize({
        Наименование: companyName,
        Рубрики: 'Барбершопы',
        'Телефон 1': rawPhone,
        'Телефон 2': null,
        'Веб-сайт 1': null,
        'WhatsApp 1': rawWhatsapp,
      });
      expect(result).toMatchObject({
        errors: [],
        normalizedData: {
          companyName,
          category: 'Барбершопы',
          phone,
          whatsapp: phone,
          phoneSource,
        },
      });
    },
  );

  it('selects the first valid phone and retains the rest as metadata', () => {
    const result = normalize({
      Наименование: 'Multiple',
      Рубрики: null,
      'Телефон 1': 'bad',
      'Телефон 2': '87051755565',
      'Веб-сайт 1': null,
      'WhatsApp 1': '77059006690',
    });
    expect(result).toMatchObject({
      normalizedData: { phone: '+77051755565', extraPhones: ['+77059006690'] },
    });
  });

  it('does not require website or WhatsApp when a phone is valid', () => {
    expect(
      normalize({
        Наименование: 'Legacy',
        Рубрики: null,
        'Телефон 1': '87051755565',
        'Телефон 2': null,
        'Веб-сайт 1': null,
        'WhatsApp 1': null,
      }),
    ).toMatchObject({ errors: [], normalizedData: { phone: '+77051755565' } });
  });
});
