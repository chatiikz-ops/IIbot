import { BusinessType, CrmProvider } from '../../generated/prisma/enums';

const CRM_DOMAINS: Array<[CrmProvider, string[]]> = [
  [CrmProvider.ZAPIS, ['zapis.kz']],
  [CrmProvider.ALTEGIO, ['alteg.io', 'altegio.com']],
  [CrmProvider.YCLIENTS, ['yclients.com']],
  [CrmProvider.DIKIDI, ['dikidi.net', 'dikidi.ru']],
  [CrmProvider.BOOKSY, ['booksy.com']],
  [CrmProvider.FRESHA, ['fresha.com']],
];

const BUSINESS_KEYWORDS: Array<[BusinessType, string[]]> = [
  [
    BusinessType.DENTAL_CLINIC,
    ['стоматология', 'стоматолог', 'dental', 'dentist'],
  ],
  [BusinessType.NAIL_STUDIO, ['ногтевая студия', 'nail', 'маникюр', 'педикюр']],
  [
    BusinessType.COSMETOLOGY,
    ['косметология', 'косметолог', 'cosmetology', 'aesthetic'],
  ],
  [BusinessType.BARBERSHOP, ['барбершоп', 'barber', 'мужская парикмахерская']],
  [BusinessType.SPA, [' spa ', 'спа', 'массажный салон']],
  [BusinessType.CLINIC, ['клиника', 'medical center', 'медицинский центр']],
  [
    BusinessType.BEAUTY_SALON,
    ['салон красоты', 'beauty salon', 'beauty studio', 'сұлулық салоны'],
  ],
];

export function detectCrmProvider(
  domains: string[],
  bookingDomain: string | null,
): CrmProvider {
  if (domains.some((domain) => matchesDomain(domain, 'zapis.kz'))) {
    return CrmProvider.ZAPIS;
  }

  for (const [provider, providerDomains] of CRM_DOMAINS.slice(1)) {
    if (
      domains.some((domain) =>
        providerDomains.some((known) => matchesDomain(domain, known)),
      )
    ) {
      return provider;
    }
  }

  if (domains.some((domain) => domain.includes('easyweek'))) {
    return CrmProvider.EASYWEEK;
  }

  const unknownBookingDomain =
    bookingDomain ?? domains.find(looksLikeBookingDomain);
  if (unknownBookingDomain && !isNonCrmDomain(unknownBookingDomain)) {
    return CrmProvider.OTHER;
  }

  return CrmProvider.UNKNOWN;
}

export function detectBusinessType(values: unknown[]): BusinessType {
  const text = ` ${values
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase('ru')} `;

  for (const [type, keywords] of BUSINESS_KEYWORDS) {
    if (keywords.some((keyword) => text.includes(keyword))) return type;
  }
  return BusinessType.UNKNOWN;
}

export function determineStrategy(
  businessType: BusinessType,
  crmProvider: CrmProvider,
): string {
  if (crmProvider === CrmProvider.ZAPIS) return 'SKIP_EXISTING_CLIENT';
  const competitor = crmProvider !== CrmProvider.UNKNOWN;
  const suffix = competitor ? 'COMPETITOR' : 'GENERAL';
  const prefixes: Partial<Record<BusinessType, string>> = {
    [BusinessType.BEAUTY_SALON]: 'BEAUTY',
    [BusinessType.BARBERSHOP]: 'BARBERSHOP',
    [BusinessType.COSMETOLOGY]: 'COSMETOLOGY',
    [BusinessType.CLINIC]: 'CLINIC',
    [BusinessType.DENTAL_CLINIC]: 'DENTAL',
    [BusinessType.NAIL_STUDIO]: 'NAIL',
    [BusinessType.SPA]: 'SPA',
  };
  return prefixes[businessType]
    ? `${prefixes[businessType]}_${suffix}`
    : `GENERIC_${suffix}`;
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function looksLikeBookingDomain(domain: string): boolean {
  return [
    'book',
    'booking',
    'reserve',
    'appointment',
    'schedule',
    'online',
  ].some((part) => domain.includes(part));
}

function isNonCrmDomain(domain: string): boolean {
  return ['instagram.com', '2gis.kz', '2gis.ru', '2gis.com'].some((known) =>
    matchesDomain(domain, known),
  );
}
