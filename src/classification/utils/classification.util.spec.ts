import { BusinessType, CrmProvider } from '../../generated/prisma/enums';
import {
  detectBusinessType,
  detectCrmProvider,
  determineStrategy,
} from './classification.util';

describe('classification production matrix', () => {
  it.each([
    [
      'Барбершоп',
      [],
      BusinessType.BARBERSHOP,
      CrmProvider.UNKNOWN,
      'BARBERSHOP_GENERAL',
    ],
    [
      'Барбершоп',
      ['alteg.io'],
      BusinessType.BARBERSHOP,
      CrmProvider.ALTEGIO,
      'BARBERSHOP_COMPETITOR',
    ],
    [
      'Салон красоты',
      ['yclients.com'],
      BusinessType.BEAUTY_SALON,
      CrmProvider.YCLIENTS,
      'BEAUTY_COMPETITOR',
    ],
    [
      'Неизвестный бизнес',
      [],
      BusinessType.UNKNOWN,
      CrmProvider.UNKNOWN,
      'GENERIC_GENERAL',
    ],
    [
      'Неизвестный бизнес',
      ['alteg.io'],
      BusinessType.UNKNOWN,
      CrmProvider.ALTEGIO,
      'GENERIC_COMPETITOR',
    ],
  ])('%s is classified safely', (name, domains, business, crm, strategy) => {
    const detectedBusiness = detectBusinessType([name]);
    const detectedCrm = detectCrmProvider(domains as string[], null);
    expect(detectedBusiness).toBe(business);
    expect(detectedCrm).toBe(crm);
    expect(determineStrategy(detectedBusiness, detectedCrm)).toBe(strategy);
  });

  it('always skips an existing Zapis client', () => {
    const crm = detectCrmProvider(['app.zapis.kz'], null);
    expect(crm).toBe(CrmProvider.ZAPIS);
    expect(determineStrategy(BusinessType.BEAUTY_SALON, crm)).toBe(
      'SKIP_EXISTING_CLIENT',
    );
  });
});
