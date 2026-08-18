import type { ColumnMapping, ImportField } from '../imports.types';

const HEADER_ALIASES: Record<ImportField, string[]> = {
  companyName: [
    'Наименование',
    'Название',
    'Компания',
    'Организация',
    'Название компании',
    'Company',
    'Company name',
    'Name',
  ],
  category: [
    'Рубрики',
    'Рубрика',
    'Категория',
    'Категории',
    'Вид деятельности',
    'Category',
    'Categories',
  ],
  phone: [
    'Телефон',
    'Тел.',
    'Мобильный',
    'Номер телефона',
    'Phone',
    'Mobile',
    'Contact phone',
  ],
  whatsapp: [
    'WhatsApp',
    'Whatsapp',
    'Whats App',
    'Ватсап',
    'WA',
    'WhatsApp URL',
  ],
  website: [
    'Веб-сайт',
    'Сайт',
    'Website',
    'Web',
    'URL',
    'Ссылка',
    'Ссылка на сайт',
  ],
  city: ['Город', 'Населенный пункт', 'Населённый пункт', 'City', 'Location'],
  address: ['Адрес', 'Полный адрес', 'Address'],
  email: ['Email', 'E-mail', 'Эл. почта', 'Электронная почта', 'Почта'],
  notes: [
    'Комментарий',
    'Комментарии',
    'Заметки',
    'Примечание',
    'Notes',
    'Description',
  ],
  instagram: ['Instagram', 'Инстаграм', 'Instagram URL', 'Социальная сеть'],
  twoGisUrl: ['2GIS', '2ГИС', 'Тугис', 'TwoGIS', '2GIS URL'],
  bookingUrl: [
    'Онлайн-запись',
    'Ссылка записи',
    'Booking',
    'Booking URL',
    'Записаться',
  ],
};

const REPEATABLE_FIELDS = new Set<ImportField>(['phone', 'whatsapp']);

export function detectColumnMapping(headers: string[]) {
  const mapping: ColumnMapping = {};
  const ambiguousColumns: string[] = [];
  const usedFields = new Set<ImportField>();
  for (const header of headers) {
    const candidates = Object.entries(HEADER_ALIASES)
      .map(([field, aliases]) => ({
        field: field as ImportField,
        score: headerScore(header, field as ImportField, aliases),
      }))
      .filter(({ score }) => score >= 0.72)
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const second = candidates[1];
    if (!best) continue;
    if (
      (second && best.score - second.score < 0.08) ||
      (usedFields.has(best.field) && !REPEATABLE_FIELDS.has(best.field))
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
    sourceProfile: detectSourceProfile(headers),
  };
}

export function detectSourceProfile(headers: string[]): '2GIS' | 'GENERIC' {
  const normalized = headers.map(normalizeHeader);
  const characteristic = normalized.filter((header) =>
    /^(телефон|веб сайт|whatsapp) \d+$/u.test(header),
  ).length;
  return normalized.includes('наименование') &&
    normalized.includes('рубрики') &&
    characteristic >= 2
    ? '2GIS'
    : 'GENERIC';
}

function headerScore(
  header: string,
  field: ImportField,
  aliases: string[],
): number {
  const normalized = normalizeHeader(header);
  if (
    field === 'whatsapp' &&
    (normalized.includes('whatsapp') ||
      normalized.includes('ватсап') ||
      /\bwa\b/u.test(normalized))
  )
    return 1;
  if (
    field === 'phone' &&
    (normalized.includes('whatsapp') ||
      normalized.includes('ватсап') ||
      normalized.includes('wa me'))
  )
    return 0;
  return Math.max(
    ...aliases.map((alias) => similarity(normalized, normalizeHeader(alias))),
  );
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const withoutSuffix = a.replace(/ \d+$/u, '');
  if (withoutSuffix === b) return 0.97;
  const distance = levenshtein(withoutSuffix, b);
  return 1 - distance / Math.max(withoutSuffix.length, b.length, 1);
}

function normalizeHeader(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('ru')
    .replace(/ё/gu, 'е')
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ');
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1)
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}
