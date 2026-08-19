/**
 * Local wall clock arithmetic.
 *
 * Everything that reasons about someone's day needs the same answers to "when does this local day
 * start" and "what weekday is this instant in their zone". One implementation, so free time and
 * planning cannot disagree about where a day begins.
 */

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Offset (ms) of `timeZone` from UTC at the given instant. */
export function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

function localDate(instant: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: read('year'), month: read('month'), day: read('day') };
}

/**
 * Instant of a local wall clock time on the calendar day containing `instant`.
 *
 * The offset is applied iteratively because the offset itself depends on the instant: on a DST
 * boundary the first guess can land in the wrong side of the change.
 */
export function localTimeOnDay(instant: Date, hour: number, timeZone: string, minute = 0): Date {
  const { year, month, day } = localDate(instant, timeZone);
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 3; i += 1) {
    const next =
      Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMs(new Date(guess), timeZone);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** Instant of local midnight on the calendar day containing `instant`. */
export function localMidnight(instant: Date, timeZone: string): Date {
  return localTimeOnDay(instant, 0, timeZone);
}

/** Local wall clock time on that day, as minutes since midnight. */
export function localTimeOnDayMinutes(instant: Date, minutes: number, timeZone: string): Date {
  return localTimeOnDay(instant, Math.floor(minutes / 60), timeZone, minutes % 60);
}

/** ISO weekday in `timeZone`: 1 is Monday, 7 is Sunday. */
export function localWeekday(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(instant);
  const index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name);
  return index === -1 ? 1 : index + 1;
}

/** YYYY-MM-DD in `timeZone`. */
export function localDateKey(instant: Date, timeZone: string): string {
  const { year, month, day } = localDate(instant, timeZone);
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
