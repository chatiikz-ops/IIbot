import { detectColumnMapping } from './column-mapping.util';

describe('detectColumnMapping', () => {
  it('detects a production 2GIS export without confusing phone and WhatsApp', () => {
    const result = detectColumnMapping([
      'Наименование',
      'Рубрики',
      'Телефон 1',
      'Телефон 2',
      'Веб-сайт 1',
      'WhatsApp 1',
    ]);
    expect(result).toMatchObject({
      sourceProfile: '2GIS',
      mapping: {
        Наименование: 'companyName',
        Рубрики: 'category',
        'Телефон 1': 'phone',
        'Телефон 2': 'phone',
        'Веб-сайт 1': 'website',
        'WhatsApp 1': 'whatsapp',
      },
      ambiguousColumns: [],
    });
  });

  it('keeps the legacy Excel aliases compatible', () => {
    expect(
      detectColumnMapping([
        'Название',
        'Телефон',
        'Город',
        'Категория',
        'Заметки',
      ]).mapping,
    ).toEqual({
      Название: 'companyName',
      Телефон: 'phone',
      Город: 'city',
      Категория: 'category',
      Заметки: 'notes',
    });
  });

  it('normalizes case, spaces, ё, underscores and numeric suffixes', () => {
    const result = detectColumnMapping([
      '  НАЗВАНИЕ   КОМПАНИИ ',
      'населённый_пункт',
      'phone-2',
      'WHATS APP 1',
    ]);
    expect(result.mapping).toMatchObject({
      '  НАЗВАНИЕ   КОМПАНИИ ': 'companyName',
      населённый_пункт: 'city',
      'phone-2': 'phone',
      'WHATS APP 1': 'whatsapp',
    });
  });
});
