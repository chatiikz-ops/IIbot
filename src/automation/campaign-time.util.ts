export type CampaignWindow = {
  withinWindow: boolean;
  nextRunAt: Date;
  localDate: string;
  dayStart: Date;
  dayEnd: Date;
  nextDayStart: Date;
};

type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsAt(date: Date, timezone: string): Parts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function zonedDate(parts: Parts, timezone: string) {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let result = new Date(desired);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = partsAt(result, timezone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    result = new Date(result.getTime() + desired - represented);
  }
  return result;
}

function clock(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid working-hours value: ${value}`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes < 0 || minutes >= 1440)
    throw new Error(`Invalid working-hours value: ${value}`);
  return minutes;
}

function addLocalDays(parts: Parts, days: number): Parts {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

export function campaignWindow(
  now: Date,
  start: string,
  end: string,
  timezone: string,
): CampaignWindow {
  const local = partsAt(now, timezone);
  const startMinutes = clock(start);
  const endMinutes = clock(end);
  const currentMinutes = local.hour * 60 + local.minute;
  const overnight = startMinutes > endMinutes;
  const withinWindow =
    startMinutes === endMinutes ||
    (overnight
      ? currentMinutes >= startMinutes || currentMinutes < endMinutes
      : currentMinutes >= startMinutes && currentMinutes < endMinutes);
  let startDayOffset = 0;
  if (!withinWindow) {
    if (!overnight && currentMinutes >= endMinutes) startDayOffset = 1;
  }
  const nextLocal = addLocalDays(local, startDayOffset);
  nextLocal.hour = Math.floor(startMinutes / 60);
  nextLocal.minute = startMinutes % 60;
  const localMidnight = {
    ...addLocalDays(local, 0),
    hour: 0,
    minute: 0,
    second: 0,
  };
  const nextMidnight = addLocalDays(local, 1);
  const nextDayStart = { ...nextMidnight };
  nextDayStart.hour = Math.floor(startMinutes / 60);
  nextDayStart.minute = startMinutes % 60;
  return {
    withinWindow,
    nextRunAt: withinWindow ? now : zonedDate(nextLocal, timezone),
    localDate: `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`,
    dayStart: zonedDate(localMidnight, timezone),
    dayEnd: zonedDate(nextMidnight, timezone),
    nextDayStart: zonedDate(nextDayStart, timezone),
  };
}
