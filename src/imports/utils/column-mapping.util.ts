import type { ColumnMapping, ImportField } from '../imports.types';

const HEADER_ALIASES: Record<ImportField, string[]> = {
  companyName: [
    'Название',
    'Компания',
    'Название компании',
    'Название салона',
    'Салон',
    'Организация',
    'Company',
    'Company Name',
    'Business Name',
  ],
  phone: [
    'Телефон',
    'Номер',
    'Мобильный',
    'WhatsApp',
    'Телефон WhatsApp',
    'Whatsapp phone',
    'Phone',
    'Mobile',
    'Contact phone',
  ],
  city: ['Город', 'Населённый пункт', 'Населенный пункт', 'City', 'Location'],
  category: [
    'Категория',
    'Тип бизнеса',
    'Рубрика',
    'Business Type',
    'Category',
  ],
  website: ['Сайт', 'Website', 'Web', 'URL', 'Ссылка', 'Ссылка на сайт'],
  instagram: ['Instagram', 'Инстаграм', 'Instagram URL', 'Социальная сеть'],
  twoGisUrl: ['2GIS', '2ГИС', 'Тугис', 'TwoGIS', '2GIS URL'],
  bookingUrl: [
    'Онлайн-запись',
    'Ссылка записи',
    'Booking',
    'Booking URL',
    'Записаться',
  ],
  email: ['Email', 'E-mail', 'Почта'],
  address: ['Адрес', 'Address'],
  notes: ['Комментарий', 'Примечание', 'Notes', 'Description'],
};

export function detectColumnMapping(headers: string[]) {
  const mapping: ColumnMapping = {};
  const ambiguousColumns: string[] = [];
  const usedFields = new Set<ImportField>();

  for (const header of headers) {
    const candidates = Object.entries(HEADER_ALIASES)
      .map(([field, aliases]) => ({
        field: field as ImportField,
        score: Math.max(...aliases.map((alias) => similarity(header, alias))),
      }))
      .filter(({ score }) => score >= 0.72)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    const second = candidates[1];

    if (!best) {
      continue;
    }

    if (
      (second && best.score - second.score < 0.08) ||
      usedFields.has(best.field)
    ) {
      ambiguousColumns.push(header);
      continue;
    }

    mapping[header] = best.field;
    usedFields.add(best.field);
  }

  return {
    mapping,
    ambiguousColumns,
    unmappedColumns: headers.filter(
      (header) => !mapping[header] && !ambiguousColumns.includes(header),
    ),
  };
}

function similarity(left: string, right: string): number {
  const a = normalizeHeader(left);
  const b = normalizeHeader(right);

  if (a === b) {
    return 1;
  }

  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length, 1);
}

function normalizeHeader(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('ru')
    .replace(/[\s_-]+/gu, '');
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
}
