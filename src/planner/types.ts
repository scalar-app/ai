/**
 * The planner's vocabulary.
 *
 * Nothing here mentions the database, HTTP or a model. `plan()` is a function from a request to a
 * proposal, which is what makes it testable and what keeps scheduling a decision Scalar can
 * explain rather than one it produced.
 */

export type PlannerPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

/** Preferred part of a day, in minutes from local midnight. */
export interface PreferredWindow {
  startMinute: number;
  endMinute: number;
}

export interface PlannerTask {
  id: string;
  title: string;
  priority: PlannerPriority;
  /** Hard deadline. Work is never proposed to end after it. */
  dueAt?: Date | undefined;
  /** How long the work takes. Falls back to `defaultFocusMinutes`. */
  estimatedMinutes?: number | undefined;
  /** Ids of tasks that must finish first. */
  dependsOn?: string[] | undefined;
  /** When the person has said when they would rather do this. */
  preferredWindow?: PreferredWindow | undefined;
}

/**
 * Time that is already spoken for. A block the planner may not move, whether it is a lecture or an
 * hour of work someone deliberately pinned.
 */
export interface PlannerBlock {
  id: string;
  startAt: Date;
  endAt: Date;
  /** Only `false` for blocks the planner itself proposed earlier in the same run. */
  locked: boolean;
}

export interface PlannerPreferences {
  timeZone: string;
  /** Minutes from local midnight. */
  workdayStartMinute: number;
  workdayEndMinute: number;
  /** ISO weekdays that count as working days, 1 is Monday. */
  workDays: number[];
  /** Used when a task carries no estimate. */
  defaultFocusMinutes: number;
  /** Gap left between a proposed block and whatever is next to it. */
  minimumBufferMinutes: number;
}

export interface PlanningRequest {
  /** Instant the plan is made at. Nothing is proposed before it. */
  now: Date;
  rangeStart: Date;
  rangeEnd: Date;
  tasks: PlannerTask[];
  /** Existing calendar events and pinned blocks. */
  blocks: PlannerBlock[];
  preferences: PlannerPreferences;
}

/**
 * Why a block ended up where it did. Machine readable so the UI can phrase it, and so a person can
 * disagree with the reasoning rather than just the result.
 */
export type PlanReason =
  | 'due_within_24_hours'
  | 'due_soon'
  | 'high_priority'
  | 'earliest_available'
  | 'fits_available_window'
  | 'preferred_focus_period'
  | 'before_deadline'
  | 'after_dependency';

export interface ProposedBlock {
  taskId: string;
  title: string;
  startAt: Date;
  endAt: Date;
  minutes: number;
  reasons: PlanReason[];
}

/**
 * Why something could not be placed. These are the shapes a day refuses in, and each one suggests
 * a different fix, which is why they are distinct rather than one "could not schedule".
 */
export type ConflictKind =
  | 'overlapping_fixed_blocks'
  | 'insufficient_time_before_deadline'
  | 'outside_working_hours'
  | 'task_too_large_for_window'
  | 'dependency_incomplete';

export interface PlanningConflict {
  kind: ConflictKind;
  /** The task this is about, when it is about one. */
  taskId?: string;
  /** Existing blocks involved, for `overlapping_fixed_blocks`. */
  blockIds?: string[];
  detail: string;
}

export type WarningKind =
  'placed_outside_preferred_window' | 'no_estimate_used_default' | 'deadline_in_the_past';

export interface PlanningWarning {
  kind: WarningKind;
  taskId?: string;
  detail: string;
}

export interface UnscheduledItem {
  taskId: string;
  title: string;
  kind: ConflictKind;
  detail: string;
}

export interface PlanningResult {
  blocks: ProposedBlock[];
  unscheduled: UnscheduledItem[];
  conflicts: PlanningConflict[];
  warnings: PlanningWarning[];
}
