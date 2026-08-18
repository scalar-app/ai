import { describe, expect, it } from 'vitest';
import { findFreeSlots, type BusyInterval } from '../src/scheduling.js';

const TZ = 'America/New_York';

function busy(start: string, end: string): BusyInterval {
  return { startsAt: new Date(start), endsAt: new Date(end) };
}

describe('findFreeSlots', () => {
  it('returns the whole working day when nothing is booked', () => {
    const slots = findFreeSlots({
      from: new Date('2026-03-10T00:00:00-04:00'),
      to: new Date('2026-03-11T00:00:00-04:00'),
      busy: [],
      minutes: 30,
      dayStartHour: 9,
      dayEndHour: 17,
      timeZone: TZ,
    });

    expect(slots).toHaveLength(1);
    expect(slots[0]?.startsAt.toISOString()).toBe('2026-03-10T13:00:00.000Z');
    expect(slots[0]?.endsAt.toISOString()).toBe('2026-03-10T21:00:00.000Z');
    expect(slots[0]?.minutes).toBe(480);
  });

  it('splits the day around a meeting', () => {
    const slots = findFreeSlots({
      from: new Date('2026-03-10T00:00:00-04:00'),
      to: new Date('2026-03-11T00:00:00-04:00'),
      busy: [busy('2026-03-10T12:00:00-04:00', '2026-03-10T13:00:00-04:00')],
      minutes: 30,
      dayStartHour: 9,
      dayEndHour: 17,
      timeZone: TZ,
    });

    expect(slots.map((slot) => slot.minutes)).toEqual([180, 240]);
  });

  it('drops gaps shorter than the requested length', () => {
    const slots = findFreeSlots({
      from: new Date('2026-03-10T00:00:00-04:00'),
      to: new Date('2026-03-11T00:00:00-04:00'),
      busy: [
        busy('2026-03-10T09:20:00-04:00', '2026-03-10T12:00:00-04:00'),
        busy('2026-03-10T13:00:00-04:00', '2026-03-10T17:00:00-04:00'),
      ],
      minutes: 45,
      dayStartHour: 9,
      dayEndHour: 17,
      timeZone: TZ,
    });

    // The 20 minute opening at 09:00 is too short; only the lunch hour survives.
    expect(slots).toHaveLength(1);
    expect(slots[0]?.minutes).toBe(60);
  });

  it('counts overlapping events once', () => {
    const slots = findFreeSlots({
      from: new Date('2026-03-10T00:00:00-04:00'),
      to: new Date('2026-03-11T00:00:00-04:00'),
      busy: [
        busy('2026-03-10T10:00:00-04:00', '2026-03-10T12:00:00-04:00'),
        busy('2026-03-10T11:00:00-04:00', '2026-03-10T13:00:00-04:00'),
        busy('2026-03-10T11:30:00-04:00', '2026-03-10T11:45:00-04:00'),
      ],
      minutes: 30,
      dayStartHour: 9,
      dayEndHour: 17,
      timeZone: TZ,
    });

    expect(slots.map((slot) => slot.minutes)).toEqual([60, 240]);
  });

  it('never proposes time in the past', () => {
    const slots = findFreeSlots({
      from: new Date('2026-03-10T00:00:00-04:00'),
      to: new Date('2026-03-11T00:00:00-04:00'),
      busy: [],
      minutes: 30,
      dayStartHour: 9,
      dayEndHour: 17,
      timeZone: TZ,
      now: new Date('2026-03-10T14:30:00-04:00'),
    });

    expect(slots).toHaveLength(1);
    expect(slots[0]?.startsAt.toISOString()).toBe('2026-03-10T18:30:00.000Z');
  });

  it('walks across several days', () => {
    const slots = findFreeSlots({
      from: new Date('2026-03-10T00:00:00-04:00'),
      to: new Date('2026-03-13T00:00:00-04:00'),
      busy: [],
      minutes: 60,
      dayStartHour: 9,
      dayEndHour: 17,
      timeZone: TZ,
    });

    expect(slots).toHaveLength(3);
    expect(slots.every((slot) => slot.minutes === 480)).toBe(true);
  });

  it('keeps working hours local across a daylight saving change', () => {
    // The US spring forward happens on 2026-03-08, so 09:00 local shifts by an hour in UTC.
    const slots = findFreeSlots({
      from: new Date('2026-03-06T00:00:00-05:00'),
      to: new Date('2026-03-10T00:00:00-04:00'),
      busy: [],
      minutes: 60,
      dayStartHour: 9,
      dayEndHour: 17,
      timeZone: TZ,
    });

    const starts = slots.map((slot) => slot.startsAt.toISOString());
    expect(starts).toContain('2026-03-06T14:00:00.000Z'); // 09:00 EST
    expect(starts).toContain('2026-03-09T13:00:00.000Z'); // 09:00 EDT
    expect(slots.every((slot) => slot.minutes === 480)).toBe(true);
  });

  it('treats hour 24 as local midnight', () => {
    const slots = findFreeSlots({
      from: new Date('2026-03-10T21:00:00-04:00'),
      to: new Date('2026-03-11T00:00:00-04:00'),
      busy: [],
      minutes: 60,
      dayStartHour: 9,
      dayEndHour: 24,
      timeZone: TZ,
    });

    expect(slots).toHaveLength(1);
    expect(slots[0]?.endsAt.toISOString()).toBe('2026-03-11T04:00:00.000Z');
  });

  it('returns nothing for an empty or inverted window', () => {
    const base = {
      busy: [],
      minutes: 30,
      dayStartHour: 9,
      dayEndHour: 17,
      timeZone: TZ,
    };
    expect(
      findFreeSlots({
        ...base,
        from: new Date('2026-03-10T12:00:00Z'),
        to: new Date('2026-03-10T12:00:00Z'),
      }),
    ).toEqual([]);
    expect(
      findFreeSlots({
        ...base,
        from: new Date('2026-03-10T15:00:00Z'),
        to: new Date('2026-03-10T12:00:00Z'),
      }),
    ).toEqual([]);
    expect(
      findFreeSlots({
        ...base,
        dayEndHour: 9,
        from: new Date('2026-03-10T00:00:00-04:00'),
        to: new Date('2026-03-11T00:00:00-04:00'),
      }),
    ).toEqual([]);
  });

  it('honors maxSlots', () => {
    const slots = findFreeSlots({
      from: new Date('2026-03-10T00:00:00-04:00'),
      to: new Date('2026-03-20T00:00:00-04:00'),
      busy: [],
      minutes: 60,
      dayStartHour: 9,
      dayEndHour: 17,
      timeZone: TZ,
      maxSlots: 3,
    });

    expect(slots).toHaveLength(3);
  });
});
