import { DAY_MS, MINUTE_MS, localTimeOnDay } from './time.js';

/**
 * Deterministic calendar arithmetic. The model asks for free time; this computes it.
 *
 * Nothing here is probabilistic, so scheduling stays reproducible and testable. The AI layer may
 * estimate how long work takes, but it never works out whether an hour is free.
 */

export interface BusyInterval {
  startsAt: Date;
  endsAt: Date;
}

export interface FindFreeSlotsInput {
  from: Date;
  to: Date;
  busy: BusyInterval[];
  /** Minimum usable gap. */
  minutes: number;
  /** Local hour the day opens, in `timeZone`. */
  dayStartHour: number;
  /** Local hour the day closes. 24 means midnight. */
  dayEndHour: number;
  timeZone: string;
  /** Nothing is proposed before this instant. Defaults to `from`. */
  now?: Date;
  maxSlots?: number;
}

export interface FreeSlot {
  startsAt: Date;
  endsAt: Date;
  minutes: number;
}

function mergeBusy(intervals: BusyInterval[]): BusyInterval[] {
  const sorted = intervals
    .filter((interval) => interval.endsAt.getTime() > interval.startsAt.getTime())
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const merged: BusyInterval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.startsAt.getTime() <= last.endsAt.getTime()) {
      if (interval.endsAt.getTime() > last.endsAt.getTime()) last.endsAt = interval.endsAt;
    } else {
      merged.push({ startsAt: interval.startsAt, endsAt: interval.endsAt });
    }
  }
  return merged;
}

/**
 * Gaps of at least `minutes` between `from` and `to`, restricted to working hours in `timeZone`
 * and to instants after `now`. Overlapping events are merged first, so double booked time is
 * counted once.
 */
export function findFreeSlots(input: FindFreeSlotsInput): FreeSlot[] {
  if (input.dayEndHour <= input.dayStartHour) return [];
  const now = input.now ?? input.from;
  const windowStart = Math.max(input.from.getTime(), now.getTime());
  const windowEnd = input.to.getTime();
  if (windowEnd <= windowStart) return [];

  const busy = mergeBusy(input.busy);
  const slots: FreeSlot[] = [];
  const maxSlots = input.maxSlots ?? 20;
  const minMs = input.minutes * MINUTE_MS;

  // Walk day by day so working hours apply in local time, including across DST changes.
  for (let cursor = windowStart; cursor < windowEnd && slots.length < maxSlots;) {
    const dayStart = localTimeOnDay(new Date(cursor), input.dayStartHour, input.timeZone).getTime();
    const dayEnd =
      input.dayEndHour === 24
        ? localTimeOnDay(new Date(cursor + DAY_MS), 0, input.timeZone).getTime()
        : localTimeOnDay(new Date(cursor), input.dayEndHour, input.timeZone).getTime();

    const openFrom = Math.max(cursor, dayStart, windowStart);
    const openTo = Math.min(dayEnd, windowEnd);

    if (openTo > openFrom) {
      let pointer = openFrom;
      for (const interval of busy) {
        const busyStart = interval.startsAt.getTime();
        const busyEnd = interval.endsAt.getTime();
        if (busyEnd <= pointer || busyStart >= openTo) continue;
        if (busyStart - pointer >= minMs) {
          slots.push({
            startsAt: new Date(pointer),
            endsAt: new Date(busyStart),
            minutes: Math.floor((busyStart - pointer) / MINUTE_MS),
          });
          if (slots.length >= maxSlots) return slots;
        }
        pointer = Math.max(pointer, busyEnd);
        if (pointer >= openTo) break;
      }
      if (openTo - pointer >= minMs) {
        slots.push({
          startsAt: new Date(pointer),
          endsAt: new Date(openTo),
          minutes: Math.floor((openTo - pointer) / MINUTE_MS),
        });
      }
    }

    // Advance to the next local midnight so day boundaries stay correct under DST.
    const nextDay = localTimeOnDay(new Date(cursor + DAY_MS), 0, input.timeZone).getTime();
    cursor = nextDay > cursor ? nextDay : cursor + DAY_MS;
  }

  return slots.slice(0, maxSlots);
}
