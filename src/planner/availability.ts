import { DAY_MS, MINUTE_MS, localTimeOnDayMinutes, localWeekday } from '../time.js';
import type { PlannerBlock, PlannerPreferences } from './types.js';

/** A stretch of time the planner is allowed to put work in. */
export interface AvailableWindow {
  start: number;
  end: number;
}

interface Interval {
  start: number;
  end: number;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/**
 * The working hours inside [from, to), one entry per working day, in the person's zone.
 *
 * Walking day by day rather than adding 24 hours is what keeps this correct across a DST change:
 * on the day a clock moves, the working day is still nine to five locally even though it is 23 or
 * 25 hours long.
 */
export function workingWindows(
  from: Date,
  to: Date,
  preferences: PlannerPreferences,
): AvailableWindow[] {
  const { timeZone, workdayStartMinute, workdayEndMinute, workDays } = preferences;
  if (workdayEndMinute <= workdayStartMinute || workDays.length === 0) return [];

  const windows: AvailableWindow[] = [];
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const allowed = new Set(workDays);

  for (let cursor = fromMs; cursor < toMs;) {
    const day = new Date(cursor);
    if (allowed.has(localWeekday(day, timeZone))) {
      const start = localTimeOnDayMinutes(day, workdayStartMinute, timeZone).getTime();
      const end =
        workdayEndMinute === 1440
          ? localTimeOnDayMinutes(new Date(cursor + DAY_MS), 0, timeZone).getTime()
          : localTimeOnDayMinutes(day, workdayEndMinute, timeZone).getTime();
      const open = Math.max(start, fromMs, cursor);
      const close = Math.min(end, toMs);
      if (close > open) windows.push({ start: open, end: close });
    }
    const nextMidnight = localTimeOnDayMinutes(new Date(cursor + DAY_MS), 0, timeZone).getTime();
    cursor = nextMidnight > cursor ? nextMidnight : cursor + DAY_MS;
  }

  return windows;
}

/**
 * Working hours minus everything already spoken for, with the buffer applied around each busy
 * interval so a proposal never lands flush against a lecture.
 *
 * The buffer expands busy time rather than shrinking proposals, which means it also applies
 * between two proposals once the first has been added to `busy`.
 */
export function availableWindows(
  from: Date,
  to: Date,
  blocks: PlannerBlock[],
  preferences: PlannerPreferences,
): AvailableWindow[] {
  const bufferMs = Math.max(0, preferences.minimumBufferMinutes) * MINUTE_MS;
  const busy = mergeIntervals(
    blocks.map((block) => ({
      start: block.startAt.getTime() - bufferMs,
      end: block.endAt.getTime() + bufferMs,
    })),
  );

  const free: AvailableWindow[] = [];
  for (const window of workingWindows(from, to, preferences)) {
    let pointer = window.start;
    for (const interval of busy) {
      if (interval.end <= pointer || interval.start >= window.end) continue;
      if (interval.start > pointer) free.push({ start: pointer, end: interval.start });
      pointer = Math.max(pointer, interval.end);
      if (pointer >= window.end) break;
    }
    if (window.end > pointer) free.push({ start: pointer, end: window.end });
  }

  return free.filter((window) => window.end > window.start);
}

/** Overlapping pairs among blocks the planner may not move. Reported, never resolved. */
export function overlappingBlocks(blocks: PlannerBlock[]): [PlannerBlock, PlannerBlock][] {
  const sorted = [...blocks].sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime() || a.id.localeCompare(b.id),
  );
  const pairs: [PlannerBlock, PlannerBlock][] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i];
      const b = sorted[j];
      if (!a || !b) continue;
      if (b.startAt.getTime() >= a.endAt.getTime()) break;
      pairs.push([a, b]);
    }
  }
  return pairs;
}
