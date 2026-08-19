import { BusinessType, CrmProvider } from '../../generated/prisma/enums';
import { SYSTEM_STRATEGY_CODES } from '../../prompt-strategies/prompt-strategies.constants';
import {
  detectBusinessType,
  detectCrmProvider,
  determineStrategy,
} from './classification.util';

describe('classification production matrix', () => {
  it.each([
    ['Барбершопы', BusinessType.BARBERSHOP],
    ['Салоны красоты', BusinessType.BEAUTY_SALON],
    ['Ногтевые студии', BusinessType.NAIL_STUDIO],
    ['Косметология', BusinessType.COSMETOLOGY],
    ['СПА', BusinessType.SPA],
    ['Стоматология', BusinessType.DENTAL_CLINIC],
    ['Медицинские центры', BusinessType.CLINIC],
    ['Сұлулық салоны', BusinessType.BEAUTY_SALON],
    ['Barbershops; Nail studio', BusinessType.NAIL_STUDIO],
  ])('detects %s', (category, expected) => {
    expect(detectBusinessType([category])).toBe(expected);
  });

  it.each([
    ['zapis.kz', CrmProvider.ZAPIS],
    ['alteg.io', CrmProvider.ALTEGIO],
    ['yclients.com', CrmProvider.YCLIENTS],
    ['dikidi.online', CrmProvider.DIKIDI],
    ['booksy.com', CrmProvider.BOOKSY],
    ['fresha.com', CrmProvider.FRESHA],
    ['easyweek.io', CrmProvider.EASYWEEK],
  ])('detects CRM %s', (domain, expected) => {
    expect(detectCrmProvider([domain], domain)).toBe(expected);
  });

  it('only returns codes from the system registry', () => {
    for (const business of Object.values(BusinessType)) {
      for (const crm of Object.values(CrmProvider)) {
        expect(SYSTEM_STRATEGY_CODES).toContain(
          determineStrategy(business, crm),
        );
      }
    }
  });

  it('always skips an existing Zapis client', () => {
    expect(
      determineStrategy(BusinessType.BEAUTY_SALON, CrmProvider.ZAPIS),
    ).toBe('SKIP_EXISTING_CLIENT');
  });
});
