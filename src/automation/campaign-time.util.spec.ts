import { campaignWindow } from './campaign-time.util';

describe('campaignWindow', () => {
  const atAlmaty = (hour: number, minute = 0) =>
    new Date(Date.UTC(2026, 7, 13, hour - 5, minute));
  it('defers before daytime start', () =>
    expect(
      campaignWindow(atAlmaty(7), '08:00', '18:00', 'Asia/Almaty').nextRunAt,
    ).toEqual(atAlmaty(8)));
  it('accepts inside daytime window', () =>
    expect(
      campaignWindow(atAlmaty(12), '08:00', '18:00', 'Asia/Almaty')
        .withinWindow,
    ).toBe(true));
  it('defers after daytime end to tomorrow', () =>
    expect(
      campaignWindow(atAlmaty(19), '08:00', '18:00', 'Asia/Almaty').nextRunAt,
    ).toEqual(new Date(Date.UTC(2026, 7, 14, 3))));
  it('accepts overnight before midnight', () =>
    expect(
      campaignWindow(atAlmaty(23), '20:00', '02:00', 'Asia/Almaty')
        .withinWindow,
    ).toBe(true));
  it('accepts overnight after midnight', () =>
    expect(
      campaignWindow(atAlmaty(1), '20:00', '02:00', 'Asia/Almaty').withinWindow,
    ).toBe(true));
  it('defers outside overnight window', () =>
    expect(
      campaignWindow(atAlmaty(12), '20:00', '02:00', 'Asia/Almaty').nextRunAt,
    ).toEqual(atAlmaty(20)));
});
