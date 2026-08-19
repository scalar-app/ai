import { MINUTE_MS, localDateKey, localTimeOnDayMinutes } from '../time.js';
import { availableWindows, overlappingBlocks, workingWindows } from './availability.js';
import type {
  ConflictKind,
  PlanReason,
  PlannerBlock,
  PlannerPriority,
  PlannerTask,
  PlanningConflict,
  PlanningRequest,
  PlanningResult,
  PlanningWarning,
  ProposedBlock,
  UnscheduledItem,
} from './types.js';

/**
 * The planner.
 *
 * A deliberately simple heuristic: put the immovable things down, work out what is left, then walk
 * the tasks in order of urgency and drop each one into the first window it fits. It is not
 * optimal and it is not trying to be. It is explainable, which matters more, because a person has
 * to be able to look at a proposed day and disagree with a specific decision.
 *
 * Rules that do not bend:
 * - Fixed blocks are never moved or removed. They are the shape of the day, not a suggestion.
 * - Nothing is proposed before `now`.
 * - Work never ends after its deadline. A task that cannot fit before its deadline comes back as
 *   unscheduled rather than as a block that quietly misses it.
 * - Anything that cannot be placed is returned with a reason. Silence would be the worst outcome.
 */

const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const PRIORITY_RANK: Record<PlannerPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

function durationFor(task: PlannerTask, defaultMinutes: number): number {
  const estimate = task.estimatedMinutes;
  return estimate !== undefined && estimate > 0 ? estimate : defaultMinutes;
}

/**
 * Urgency first, then priority, then the shorter job, then id.
 *
 * The id tiebreak is not cosmetic: two runs over the same day must produce the same plan, or
 * "apply" would mean something different from the preview the person approved.
 */
function compareTasks(a: PlannerTask, b: PlannerTask, now: Date): number {
  const bucket = (task: PlannerTask): number => {
    if (!task.dueAt) return 3;
    const ms = task.dueAt.getTime() - now.getTime();
    if (ms <= DAY_MS) return 0;
    if (ms <= 7 * DAY_MS) return 1;
    return 2;
  };
  const bucketDiff = bucket(a) - bucket(b);
  if (bucketDiff !== 0) return bucketDiff;

  const priorityDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priorityDiff !== 0) return priorityDiff;

  const dueDiff = (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity);
  if (dueDiff !== 0 && Number.isFinite(dueDiff)) return dueDiff;

  const sizeDiff = (a.estimatedMinutes ?? 0) - (b.estimatedMinutes ?? 0);
  if (sizeDiff !== 0) return sizeDiff;

  return a.id.localeCompare(b.id);
}

/**
 * Dependencies before dependants, urgency order otherwise.
 *
 * Tasks in a dependency cycle are returned in `cyclic`: there is no order that satisfies them, and
 * guessing one would produce a plan that cannot be right.
 */
function orderTasks(
  tasks: PlannerTask[],
  now: Date,
): { ordered: PlannerTask[]; cyclic: PlannerTask[] } {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const sorted = [...tasks].sort((a, b) => compareTasks(a, b, now));

  const ordered: PlannerTask[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const cyclic = new Set<string>();

  const visit = (task: PlannerTask, trail: Set<string>): void => {
    const current = state.get(task.id);
    if (current === 'done') return;
    if (current === 'visiting') {
      for (const id of trail) cyclic.add(id);
      cyclic.add(task.id);
      return;
    }
    state.set(task.id, 'visiting');
    trail.add(task.id);
    for (const dependencyId of task.dependsOn ?? []) {
      const dependency = byId.get(dependencyId);
      // An id from outside this request is something the planner cannot see, so it is taken as
      // already done rather than treated as a blocker.
      if (dependency) visit(dependency, trail);
    }
    trail.delete(task.id);
    state.set(task.id, 'done');
    ordered.push(task);
  };

  for (const task of sorted) visit(task, new Set());

  return {
    ordered: ordered.filter((task) => !cyclic.has(task.id)),
    cyclic: sorted.filter((task) => cyclic.has(task.id)),
  };
}

/** The preferred part of the day that overlaps a window, if any. */
function preferredSlice(
  window: { start: number; end: number },
  task: PlannerTask,
  timeZone: string,
): { start: number; end: number } | null {
  const preference = task.preferredWindow;
  if (!preference) return null;
  const day = new Date(window.start);
  const start = localTimeOnDayMinutes(day, preference.startMinute, timeZone).getTime();
  const end =
    preference.endMinute === 1440
      ? localTimeOnDayMinutes(new Date(window.start + DAY_MS), 0, timeZone).getTime()
      : localTimeOnDayMinutes(day, preference.endMinute, timeZone).getTime();
  const from = Math.max(window.start, start);
  const to = Math.min(window.end, end);
  return to > from ? { start: from, end: to } : null;
}

interface Placement {
  start: number;
  end: number;
  inPreferred: boolean;
  isEarliest: boolean;
}

function findPlacement(
  windows: { start: number; end: number }[],
  durationMs: number,
  task: PlannerTask,
  timeZone: string,
): Placement | null {
  const earliestStart = windows[0]?.start;

  /*
   * Day by day, and inside a day the preference first.
   *
   * Sooner matters more than nicer: someone who prefers afternoons still wants work that could
   * happen today to happen today, rather than waiting for tomorrow afternoon. But once the day is
   * settled, the preference decides where in it the work goes. Scanning every window for a
   * preferred slice before considering any other window would quietly push work later, which is
   * how a preference turns into a delay.
   */
  const days = new Map<string, { start: number; end: number }[]>();
  for (const window of windows) {
    const key = localDateKey(new Date(window.start), timeZone);
    const existing = days.get(key);
    if (existing) existing.push(window);
    else days.set(key, [window]);
  }

  for (const dayWindows of days.values()) {
    for (const window of dayWindows) {
      const slice = preferredSlice(window, task, timeZone);
      if (slice && slice.end - slice.start >= durationMs) {
        return {
          start: slice.start,
          end: slice.start + durationMs,
          inPreferred: true,
          isEarliest: slice.start === earliestStart,
        };
      }
    }
    for (const window of dayWindows) {
      if (window.end - window.start >= durationMs) {
        return {
          start: window.start,
          end: window.start + durationMs,
          inPreferred: false,
          isEarliest: window.start === earliestStart,
        };
      }
    }
  }

  return null;
}

function reasonsFor(
  task: PlannerTask,
  placement: Placement,
  now: Date,
  hasDependency: boolean,
): PlanReason[] {
  const reasons: PlanReason[] = [];
  if (task.dueAt) {
    const ms = task.dueAt.getTime() - now.getTime();
    if (ms <= DAY_MS) reasons.push('due_within_24_hours');
    else if (ms <= 7 * DAY_MS) reasons.push('due_soon');
  }
  if (task.priority === 'high' || task.priority === 'urgent') reasons.push('high_priority');
  if (hasDependency) reasons.push('after_dependency');
  if (placement.inPreferred) reasons.push('preferred_focus_period');
  if (placement.isEarliest) reasons.push('earliest_available');
  reasons.push('fits_available_window');
  if (task.dueAt) reasons.push('before_deadline');
  return reasons;
}

/**
 * Why a task did not fit. The distinction matters because each one has a different answer: a
 * deadline that cannot be met is a conversation, a task larger than any gap is a task that needs
 * splitting, and a week with no working days is a settings problem.
 */
function classifyFailure(
  task: PlannerTask,
  durationMs: number,
  windowsBeforeDeadline: { start: number; end: number }[],
  windowsInRange: { start: number; end: number }[],
  hasWorkingHours: boolean,
): { kind: ConflictKind; detail: string } {
  if (!hasWorkingHours) {
    return {
      kind: 'outside_working_hours',
      detail: 'There are no working hours in this range to place work in.',
    };
  }
  const minutes = Math.round(durationMs / MINUTE_MS);
  if (windowsBeforeDeadline.length === 0) {
    return task.dueAt
      ? {
          kind: 'insufficient_time_before_deadline',
          detail: 'There is no free working time left before this is due.',
        }
      : {
          kind: 'task_too_large_for_window',
          detail: 'There is no free working time left in this range.',
        };
  }
  const largest = Math.max(
    ...windowsBeforeDeadline.map((window) => Math.round((window.end - window.start) / MINUTE_MS)),
  );
  if (task.dueAt && windowsInRange.some((window) => window.end - window.start >= durationMs)) {
    return {
      kind: 'insufficient_time_before_deadline',
      detail: `This needs ${String(minutes)} minutes and the largest free block before it is due is ${String(largest)}.`,
    };
  }
  return {
    kind: 'task_too_large_for_window',
    detail: `This needs ${String(minutes)} minutes and the largest free block is ${String(largest)}.`,
  };
}

export function plan(request: PlanningRequest): PlanningResult {
  const { now, rangeStart, rangeEnd, preferences } = request;
  const blocks: ProposedBlock[] = [];
  const unscheduled: UnscheduledItem[] = [];
  const conflicts: PlanningConflict[] = [];
  const warnings: PlanningWarning[] = [];

  // Existing overlaps are reported and then planned around. Someone double booked at ten is a fact
  // about their day; refusing to plan the rest of it would not help.
  for (const [a, b] of overlappingBlocks(request.blocks)) {
    conflicts.push({
      kind: 'overlapping_fixed_blocks',
      blockIds: [a.id, b.id],
      detail: 'Two things that cannot move are booked at the same time.',
    });
  }

  const planFrom = new Date(Math.max(rangeStart.getTime(), now.getTime()));
  const hasWorkingHours = workingWindows(planFrom, rangeEnd, preferences).length > 0;

  const { ordered, cyclic } = orderTasks(request.tasks, now);
  for (const task of cyclic) {
    unscheduled.push({
      taskId: task.id,
      title: task.title,
      kind: 'dependency_incomplete',
      detail: 'These tasks depend on each other, so there is no order that works.',
    });
    conflicts.push({
      kind: 'dependency_incomplete',
      taskId: task.id,
      detail: 'Circular dependency.',
    });
  }

  // Grows as work is placed, so later tasks plan around earlier proposals as well as around
  // whatever was already fixed.
  const busy: PlannerBlock[] = [...request.blocks];
  const finishedAt = new Map<string, number>();
  const failed = new Set<string>(cyclic.map((task) => task.id));

  for (const task of ordered) {
    const dependencyIds = (task.dependsOn ?? []).filter((id) =>
      request.tasks.some((candidate) => candidate.id === id),
    );
    const blockedBy = dependencyIds.filter((id) => failed.has(id));
    if (blockedBy.length > 0) {
      failed.add(task.id);
      unscheduled.push({
        taskId: task.id,
        title: task.title,
        kind: 'dependency_incomplete',
        detail: 'Something this depends on could not be scheduled.',
      });
      conflicts.push({
        kind: 'dependency_incomplete',
        taskId: task.id,
        detail: `Depends on ${blockedBy.join(', ')}, which could not be scheduled.`,
      });
      continue;
    }

    if (task.estimatedMinutes === undefined || task.estimatedMinutes <= 0) {
      warnings.push({
        kind: 'no_estimate_used_default',
        taskId: task.id,
        detail: `No estimate, so ${String(preferences.defaultFocusMinutes)} minutes was assumed.`,
      });
    }
    if (task.dueAt && task.dueAt.getTime() < now.getTime()) {
      warnings.push({
        kind: 'deadline_in_the_past',
        taskId: task.id,
        detail: 'This was already due, so it is placed as early as possible.',
      });
    }

    const durationMs = durationFor(task, preferences.defaultFocusMinutes) * MINUTE_MS;
    const dependencyEnd = Math.max(
      planFrom.getTime(),
      ...dependencyIds.map((id) => finishedAt.get(id) ?? planFrom.getTime()),
    );
    const from = new Date(dependencyEnd);

    // A deadline in the past cannot bound the search, or there would be nothing to search.
    const deadline =
      task.dueAt && task.dueAt.getTime() > now.getTime() ? task.dueAt.getTime() : null;
    const until = new Date(Math.min(rangeEnd.getTime(), deadline ?? rangeEnd.getTime()));

    const windowsBeforeDeadline =
      until.getTime() > from.getTime() ? availableWindows(from, until, busy, preferences) : [];
    const placement = findPlacement(windowsBeforeDeadline, durationMs, task, preferences.timeZone);

    if (!placement) {
      const windowsInRange =
        rangeEnd.getTime() > from.getTime()
          ? availableWindows(from, rangeEnd, busy, preferences)
          : [];
      const failure = classifyFailure(
        task,
        durationMs,
        windowsBeforeDeadline,
        windowsInRange,
        hasWorkingHours,
      );
      failed.add(task.id);
      unscheduled.push({ taskId: task.id, title: task.title, ...failure });
      conflicts.push({ kind: failure.kind, taskId: task.id, detail: failure.detail });
      continue;
    }

    if (task.preferredWindow && !placement.inPreferred) {
      warnings.push({
        kind: 'placed_outside_preferred_window',
        taskId: task.id,
        detail: 'There was no free time in the preferred part of the day.',
      });
    }

    blocks.push({
      taskId: task.id,
      title: task.title,
      startAt: new Date(placement.start),
      endAt: new Date(placement.end),
      minutes: Math.round((placement.end - placement.start) / MINUTE_MS),
      reasons: reasonsFor(task, placement, now, dependencyIds.length > 0),
    });
    finishedAt.set(task.id, placement.end);
    busy.push({
      id: `proposed:${task.id}`,
      startAt: new Date(placement.start),
      endAt: new Date(placement.end),
      locked: false,
    });
  }

  blocks.sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime() || a.taskId.localeCompare(b.taskId),
  );

  return { blocks, unscheduled, conflicts, warnings };
}
