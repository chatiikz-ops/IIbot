import { BusinessType, CrmProvider } from '../../generated/prisma/enums';
import { SYSTEM_STRATEGY_CODES } from '../../prompt-strategies/prompt-strategies.constants';

export type SystemStrategyCode = (typeof SYSTEM_STRATEGY_CODES)[number];
const CRM_DOMAINS: Array<[CrmProvider, string[]]> = [
  [CrmProvider.ZAPIS, ['zapis.kz']],
  [CrmProvider.ALTEGIO, ['alteg.io', 'altegio.com']],
  [CrmProvider.YCLIENTS, ['yclients.com']],
  [CrmProvider.DIKIDI, ['dikidi.net', 'dikidi.ru', 'dikidi.online']],
  [CrmProvider.BOOKSY, ['booksy.com']],
  [CrmProvider.FRESHA, ['fresha.com']],
  [CrmProvider.EASYWEEK, ['easyweek.io', 'easyweek.app', 'easyweek.com']],
];
const BUSINESS_KEYWORDS: Array<[BusinessType, string[]]> = [
  [
    BusinessType.DENTAL_CLINIC,
    [
      '\u0441\u0442\u043e\u043c\u0430\u0442\u043e\u043b\u043e\u0433',
      'dental',
      'dentist',
    ],
  ],
  [
    BusinessType.NAIL_STUDIO,
    [
      '\u043d\u043e\u0433\u0442',
      '\u043c\u0430\u043d\u0438\u043a\u044e\u0440',
      '\u043f\u0435\u0434\u0438\u043a\u044e\u0440',
      'nail',
    ],
  ],
  [
    BusinessType.COSMETOLOGY,
    [
      '\u043a\u043e\u0441\u043c\u0435\u0442\u043e\u043b\u043e\u0433',
      'cosmetology',
      'aesthetic',
    ],
  ],
  [
    BusinessType.BARBERSHOP,
    ['\u0431\u0430\u0440\u0431\u0435\u0440\u0448\u043e\u043f', 'barber'],
  ],
  [
    BusinessType.SPA,
    [' spa ', '\u0441\u043f\u0430', '\u043c\u0430\u0441\u0441\u0430\u0436'],
  ],
  [
    BusinessType.CLINIC,
    [
      '\u043a\u043b\u0438\u043d\u0438\u043a',
      'medical center',
      '\u043c\u0435\u0434\u0438\u0446\u0438\u043d\u0441\u043a',
    ],
  ],
  [
    BusinessType.BEAUTY_SALON,
    [
      '\u0441\u0430\u043b\u043e\u043d',
      'beauty salon',
      'beauty studio',
      '\u0441\u04b1\u043b\u0443\u043b\u044b\u049b',
    ],
  ],
];

export function detectCrmProvider(
  domains: string[],
  bookingDomain: string | null,
): CrmProvider {
  for (const [provider, knownDomains] of CRM_DOMAINS) {
    if (
      domains.some((domain) =>
        knownDomains.some((known) => matchesDomain(domain, known)),
      )
    )
      return provider;
  }
  const unknownBookingDomain =
    bookingDomain ?? domains.find(looksLikeBookingDomain);
  if (unknownBookingDomain && !isNonCrmDomain(unknownBookingDomain))
    return CrmProvider.OTHER;
  return CrmProvider.UNKNOWN;
}

export function detectBusinessType(values: unknown[]): BusinessType {
  const text = ` ${values
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replace(/\u0451/gu, '\u0435')} `;
  for (const [type, keywords] of BUSINESS_KEYWORDS)
    if (keywords.some((keyword) => text.includes(keyword))) return type;
  return BusinessType.UNKNOWN;
}

export function determineStrategy(
  businessType: BusinessType,
  crmProvider: CrmProvider,
): SystemStrategyCode {
  if (crmProvider === CrmProvider.ZAPIS) return 'SKIP_EXISTING_CLIENT';
  const suffix = crmProvider === CrmProvider.UNKNOWN ? 'GENERAL' : 'COMPETITOR';
  const prefixes: Partial<Record<BusinessType, string>> = {
    [BusinessType.BEAUTY_SALON]: 'BEAUTY',
    [BusinessType.BARBERSHOP]: 'BARBERSHOP',
    [BusinessType.COSMETOLOGY]: 'COSMETOLOGY',
    [BusinessType.CLINIC]: 'CLINIC',
    [BusinessType.DENTAL_CLINIC]: 'DENTAL',
    [BusinessType.NAIL_STUDIO]: 'NAIL',
    [BusinessType.SPA]: 'SPA',
  };
  const code = `${prefixes[businessType] ?? 'GENERIC'}_${suffix}`;
  if (!isSystemStrategyCode(code))
    throw new Error(`Unsupported system strategy: ${code}`);
  return code;
}

export function isSystemStrategyCode(
  value: string,
): value is SystemStrategyCode {
  return (SYSTEM_STRATEGY_CODES as readonly string[]).includes(value);
}
function matchesDomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}
function looksLikeBookingDomain(domain: string) {
  return [
    'book',
    'booking',
    'reserve',
    'appointment',
    'schedule',
    'online',
  ].some((part) => domain.includes(part));
}
function isNonCrmDomain(domain: string) {
  return ['instagram.com', '2gis.kz', '2gis.ru', '2gis.com'].some((known) =>
    matchesDomain(domain, known),
  );
}
