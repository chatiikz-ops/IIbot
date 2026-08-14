import { detectColumnMapping } from './column-mapping.util';

describe('detectColumnMapping', () => {
  it('supports production Russian aliases including Заметки', () => {
    const result = detectColumnMapping([
      'Название салона',
      'WhatsApp',
      'Город',
      'Тип бизнеса',
      '2ГИС',
      'Ссылка записи',
      'Почта',
      'Адрес',
      'Заметки',
    ]);
    expect(result.mapping).toMatchObject({
      'Название салона': 'companyName',
      WhatsApp: 'phone',
      Город: 'city',
      'Тип бизнеса': 'category',
      '2ГИС': 'twoGisUrl',
      'Ссылка записи': 'bookingUrl',
      Почта: 'email',
      Адрес: 'address',
      Заметки: 'notes',
    });
  });

  it('does not silently map a second column to an already used field', () => {
    const result = detectColumnMapping(['Телефон', 'Номер']);
    expect(Object.values(result.mapping)).toEqual(['phone']);
    expect(result.ambiguousColumns).toEqual(['Номер']);
  });
});
