import { describe, expect, it } from 'vitest';
import { plan } from '../src/planner/plan.js';
import type {
  PlannerBlock,
  PlannerPreferences,
  PlannerTask,
  PlanningRequest,
} from '../src/planner/types.js';

/**
 * The planner is the part of Scalar that decides where someone's time goes, so it is tested at the
 * level of days rather than functions: an empty day, a full one, a deadline that cannot be met.
 */

const UTC_PREFERENCES: PlannerPreferences = {
  timeZone: 'UTC',
  workdayStartMinute: 9 * 60,
  workdayEndMinute: 17 * 60,
  workDays: [1, 2, 3, 4, 5],
  defaultFocusMinutes: 50,
  minimumBufferMinutes: 0,
};

// Wednesday 2026-08-19, 08:00 UTC: before the working day starts.
const NOW = new Date('2026-08-19T08:00:00.000Z');

function task(over: Partial<PlannerTask> & { id: string }): PlannerTask {
  return {
    title: over.title ?? `Task ${over.id}`,
    priority: over.priority ?? 'none',
    ...over,
  };
}

function block(id: string, startAt: string, endAt: string): PlannerBlock {
  return { id, startAt: new Date(startAt), endAt: new Date(endAt), locked: true };
}

function request(over: Partial<PlanningRequest> = {}): PlanningRequest {
  return {
    now: NOW,
    rangeStart: NOW,
    rangeEnd: new Date('2026-08-20T00:00:00.000Z'),
    tasks: [],
    blocks: [],
    preferences: UTC_PREFERENCES,
    ...over,
  };
}

/** Undefined becomes a readable sentinel, so a missing block fails as a diff rather than a throw. */
function iso(date: Date | undefined): string {
  return date?.toISOString() ?? 'nothing scheduled';
}

describe('plan: an empty day', () => {
  it('places a single task at the start of working hours', () => {
    const result = plan(
      request({ tasks: [task({ id: 't1', title: 'Write up', estimatedMinutes: 60 })] }),
    );

    expect(result.blocks).toHaveLength(1);
    expect(iso(result.blocks[0]?.startAt)).toBe('2026-08-19T09:00:00.000Z');
    expect(iso(result.blocks[0]?.endAt)).toBe('2026-08-19T10:00:00.000Z');
    expect(result.unscheduled).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('returns nothing at all when there is nothing to do', () => {
    const result = plan(request());
    expect(result).toEqual({ blocks: [], unscheduled: [], conflicts: [], warnings: [] });
  });

  it('never proposes work in the past', () => {
    const result = plan(
      request({
        now: new Date('2026-08-19T12:30:00.000Z'),
        rangeStart: new Date('2026-08-19T00:00:00.000Z'),
        tasks: [task({ id: 't1', estimatedMinutes: 60 })],
      }),
    );
    expect(iso(result.blocks[0]?.startAt)).toBe('2026-08-19T12:30:00.000Z');
  });

  it('assumes the default length when a task has no estimate, and says so', () => {
    const result = plan(request({ tasks: [task({ id: 't1' })] }));

    expect(result.blocks[0]?.minutes).toBe(50);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: 'no_estimate_used_default', taskId: 't1' }),
    );
  });
});

describe('plan: working around what cannot move', () => {
  it('plans around a fixed block rather than over it', () => {
    const result = plan(
      request({
        blocks: [block('lecture', '2026-08-19T09:00:00.000Z', '2026-08-19T10:30:00.000Z')],
        tasks: [task({ id: 't1', estimatedMinutes: 60 })],
      }),
    );

    expect(iso(result.blocks[0]?.startAt)).toBe('2026-08-19T10:30:00.000Z');
  });

  it('leaves the configured buffer around existing blocks and around its own proposals', () => {
    const result = plan(
      request({
        preferences: { ...UTC_PREFERENCES, minimumBufferMinutes: 15 },
        blocks: [block('lecture', '2026-08-19T09:00:00.000Z', '2026-08-19T10:00:00.000Z')],
        tasks: [task({ id: 't1', estimatedMinutes: 60 }), task({ id: 't2', estimatedMinutes: 60 })],
      }),
    );

    expect(iso(result.blocks[0]?.startAt)).toBe('2026-08-19T10:15:00.000Z');
    // 15 minutes after the first proposal ends, not flush against it.
    expect(iso(result.blocks[1]?.startAt)).toBe('2026-08-19T11:30:00.000Z');
  });

  it('reports overlapping fixed blocks and still plans the rest of the day', () => {
    const result = plan(
      request({
        blocks: [
          block('a', '2026-08-19T09:00:00.000Z', '2026-08-19T11:00:00.000Z'),
          block('b', '2026-08-19T10:00:00.000Z', '2026-08-19T12:00:00.000Z'),
        ],
        tasks: [task({ id: 't1', estimatedMinutes: 30 })],
      }),
    );

    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ kind: 'overlapping_fixed_blocks', blockIds: ['a', 'b'] }),
    );
    expect(iso(result.blocks[0]?.startAt)).toBe('2026-08-19T12:00:00.000Z');
  });

  it('returns a task that cannot fit in a fully booked day, without touching the bookings', () => {
    const blocks = [block('all-day', '2026-08-19T09:00:00.000Z', '2026-08-19T17:00:00.000Z')];
    const result = plan(request({ blocks, tasks: [task({ id: 't1', estimatedMinutes: 60 })] }));

    expect(result.blocks).toEqual([]);
    expect(result.unscheduled[0]).toMatchObject({ taskId: 't1' });
    // The input is untouched: the planner proposes, it does not rearrange.
    expect(iso(blocks[0]?.startAt)).toBe('2026-08-19T09:00:00.000Z');
  });
});

describe('plan: ordering', () => {
  it('puts what is due within a day ahead of what is merely important', () => {
    const result = plan(
      request({
        rangeEnd: new Date('2026-08-21T00:00:00.000Z'),
        tasks: [
          task({ id: 'important', priority: 'urgent', estimatedMinutes: 60 }),
          task({
            id: 'due-today',
            priority: 'low',
            dueAt: new Date('2026-08-19T17:00:00.000Z'),
            estimatedMinutes: 60,
          }),
        ],
      }),
    );

    expect(result.blocks.map((b) => b.taskId)).toEqual(['due-today', 'important']);
  });

  it('orders by priority when urgency is equal', () => {
    const result = plan(
      request({
        tasks: [
          task({ id: 'low', priority: 'low', estimatedMinutes: 60 }),
          task({ id: 'high', priority: 'high', estimatedMinutes: 60 }),
          task({ id: 'medium', priority: 'medium', estimatedMinutes: 60 }),
        ],
      }),
    );

    expect(result.blocks.map((b) => b.taskId)).toEqual(['high', 'medium', 'low']);
  });

  it('is deterministic for tasks that are alike in every way', () => {
    const tasks = [
      task({ id: 'b', estimatedMinutes: 60 }),
      task({ id: 'a', estimatedMinutes: 60 }),
      task({ id: 'c', estimatedMinutes: 60 }),
    ];
    const first = plan(request({ tasks }));
    const second = plan(request({ tasks: [...tasks].reverse() }));

    expect(first.blocks.map((b) => b.taskId)).toEqual(['a', 'b', 'c']);
    expect(second.blocks.map((b) => b.taskId)).toEqual(first.blocks.map((b) => b.taskId));
  });
});

describe('plan: deadlines', () => {
  it('never proposes work that ends after the deadline', () => {
    const result = plan(
      request({
        tasks: [
          task({
            id: 't1',
            dueAt: new Date('2026-08-19T11:00:00.000Z'),
            estimatedMinutes: 90,
          }),
        ],
      }),
    );

    expect(iso(result.blocks[0]?.endAt)).toBe('2026-08-19T10:30:00.000Z');
    expect(result.blocks[0]?.reasons).toContain('before_deadline');
  });

  it('reports a deadline that cannot be met rather than missing it quietly', () => {
    const result = plan(
      request({
        rangeEnd: new Date('2026-08-22T00:00:00.000Z'),
        blocks: [block('busy', '2026-08-19T09:00:00.000Z', '2026-08-19T12:00:00.000Z')],
        tasks: [
          task({
            id: 't1',
            title: 'Problem set',
            dueAt: new Date('2026-08-19T11:00:00.000Z'),
            estimatedMinutes: 60,
          }),
        ],
      }),
    );

    expect(result.blocks).toEqual([]);
    expect(result.unscheduled[0]).toMatchObject({
      taskId: 't1',
      kind: 'insufficient_time_before_deadline',
    });
    expect(result.conflicts[0]?.kind).toBe('insufficient_time_before_deadline');
  });

  it('still places work that was already due, and says the deadline has passed', () => {
    const result = plan(
      request({
        tasks: [
          task({
            id: 't1',
            dueAt: new Date('2026-08-18T17:00:00.000Z'),
            estimatedMinutes: 60,
          }),
        ],
      }),
    );

    expect(result.blocks).toHaveLength(1);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: 'deadline_in_the_past', taskId: 't1' }),
    );
  });

  it('marks something due within a day differently from something due next week', () => {
    const result = plan(
      request({
        rangeEnd: new Date('2026-08-26T00:00:00.000Z'),
        tasks: [
          task({ id: 'soon', dueAt: new Date('2026-08-19T20:00:00.000Z'), estimatedMinutes: 30 }),
          task({ id: 'later', dueAt: new Date('2026-08-24T12:00:00.000Z'), estimatedMinutes: 30 }),
        ],
      }),
    );

    expect(result.blocks.find((b) => b.taskId === 'soon')?.reasons).toContain(
      'due_within_24_hours',
    );
    expect(result.blocks.find((b) => b.taskId === 'later')?.reasons).toContain('due_soon');
  });
});

describe('plan: what will not fit', () => {
  it('says when a task is larger than any free block it has', () => {
    const result = plan(
      request({
        tasks: [task({ id: 'huge', title: 'Rewrite everything', estimatedMinutes: 10 * 60 })],
      }),
    );

    expect(result.unscheduled[0]).toMatchObject({
      taskId: 'huge',
      kind: 'task_too_large_for_window',
    });
    expect(result.unscheduled[0]?.detail).toContain('480');
  });

  it('says when there are no working hours in the range at all', () => {
    const result = plan(
      request({
        // Saturday to Sunday, with a Monday to Friday working week.
        now: new Date('2026-08-22T08:00:00.000Z'),
        rangeStart: new Date('2026-08-22T08:00:00.000Z'),
        rangeEnd: new Date('2026-08-24T00:00:00.000Z'),
        tasks: [task({ id: 't1', estimatedMinutes: 30 })],
      }),
    );

    expect(result.unscheduled[0]).toMatchObject({ kind: 'outside_working_hours' });
  });

  it('places what fits and reports what does not, rather than giving up on the day', () => {
    const result = plan(
      request({
        tasks: [
          task({ id: 'fits', priority: 'high', estimatedMinutes: 6 * 60 }),
          task({ id: 'does-not', priority: 'low', estimatedMinutes: 5 * 60 }),
        ],
      }),
    );

    expect(result.blocks.map((b) => b.taskId)).toEqual(['fits']);
    expect(result.unscheduled.map((u) => u.taskId)).toEqual(['does-not']);
  });
});

describe('plan: preferred windows', () => {
  it('uses the preferred part of the day when it is free', () => {
    const result = plan(
      request({
        tasks: [
          task({
            id: 't1',
            estimatedMinutes: 60,
            preferredWindow: { startMinute: 14 * 60, endMinute: 17 * 60 },
          }),
        ],
      }),
    );

    expect(iso(result.blocks[0]?.startAt)).toBe('2026-08-19T14:00:00.000Z');
    expect(result.blocks[0]?.reasons).toContain('preferred_focus_period');
    expect(result.warnings).toEqual([]);
  });

  it('falls back outside the preference rather than not scheduling, and says so', () => {
    const result = plan(
      request({
        blocks: [block('busy', '2026-08-19T13:00:00.000Z', '2026-08-19T17:00:00.000Z')],
        tasks: [
          task({
            id: 't1',
            estimatedMinutes: 60,
            preferredWindow: { startMinute: 14 * 60, endMinute: 17 * 60 },
          }),
        ],
      }),
    );

    expect(iso(result.blocks[0]?.startAt)).toBe('2026-08-19T09:00:00.000Z');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: 'placed_outside_preferred_window', taskId: 't1' }),
    );
  });

  it('prefers today outside the window over tomorrow inside it', () => {
    const result = plan(
      request({
        rangeEnd: new Date('2026-08-21T00:00:00.000Z'),
        blocks: [block('busy', '2026-08-19T13:00:00.000Z', '2026-08-19T17:00:00.000Z')],
        tasks: [
          task({
            id: 't1',
            dueAt: new Date('2026-08-20T17:00:00.000Z'),
            estimatedMinutes: 60,
            preferredWindow: { startMinute: 14 * 60, endMinute: 17 * 60 },
          }),
        ],
      }),
    );

    expect(iso(result.blocks[0]?.startAt)).toBe('2026-08-19T09:00:00.000Z');
  });
});

describe('plan: dependencies', () => {
  it('schedules a dependency before the task that needs it', () => {
    const result = plan(
      request({
        tasks: [
          task({ id: 'second', priority: 'urgent', estimatedMinutes: 60, dependsOn: ['first'] }),
          task({ id: 'first', priority: 'low', estimatedMinutes: 60 }),
        ],
      }),
    );

    expect(result.blocks.map((b) => b.taskId)).toEqual(['first', 'second']);
    expect(result.blocks[1]?.startAt.getTime() ?? 0).toBeGreaterThanOrEqual(
      result.blocks[0]?.endAt.getTime() ?? 0,
    );
    expect(result.blocks[1]?.reasons).toContain('after_dependency');
  });

  it('does not schedule a task whose dependency could not be scheduled', () => {
    const result = plan(
      request({
        tasks: [
          task({ id: 'blocked', estimatedMinutes: 30, dependsOn: ['huge'] }),
          task({ id: 'huge', estimatedMinutes: 10 * 60 }),
        ],
      }),
    );

    expect(result.blocks).toEqual([]);
    expect(result.unscheduled.map((u) => u.kind)).toContain('dependency_incomplete');
  });

  it('refuses a dependency cycle instead of picking an order', () => {
    const result = plan(
      request({
        tasks: [
          task({ id: 'a', estimatedMinutes: 30, dependsOn: ['b'] }),
          task({ id: 'b', estimatedMinutes: 30, dependsOn: ['a'] }),
        ],
      }),
    );

    expect(result.blocks).toEqual([]);
    expect(result.unscheduled.map((u) => u.taskId).sort()).toEqual(['a', 'b']);
    expect(result.unscheduled.every((u) => u.kind === 'dependency_incomplete')).toBe(true);
  });

  it('treats a dependency it cannot see as already done', () => {
    const result = plan(
      request({ tasks: [task({ id: 't1', estimatedMinutes: 60, dependsOn: ['elsewhere'] })] }),
    );
    expect(result.blocks).toHaveLength(1);
  });
});

describe('plan: time zones', () => {
  it('uses working hours in the person’s zone, not the server’s', () => {
    const result = plan(
      request({
        now: new Date('2026-08-19T08:00:00.000Z'),
        rangeStart: new Date('2026-08-19T08:00:00.000Z'),
        rangeEnd: new Date('2026-08-20T12:00:00.000Z'),
        preferences: { ...UTC_PREFERENCES, timeZone: 'America/Los_Angeles' },
        tasks: [task({ id: 't1', estimatedMinutes: 60 })],
      }),
    );

    // 09:00 in Los Angeles on the 19th is 16:00 UTC.
    expect(iso(result.blocks[0]?.startAt)).toBe('2026-08-19T16:00:00.000Z');
  });

  it('keeps working hours at nine local across a spring DST change', () => {
    const berlin: PlannerPreferences = { ...UTC_PREFERENCES, timeZone: 'Europe/Berlin' };

    // Friday, before the clocks go forward on Sunday 2026-03-29.
    const before = plan(
      request({
        now: new Date('2026-03-27T06:00:00.000Z'),
        rangeStart: new Date('2026-03-27T06:00:00.000Z'),
        rangeEnd: new Date('2026-03-28T00:00:00.000Z'),
        preferences: berlin,
        tasks: [task({ id: 't1', estimatedMinutes: 60 })],
      }),
    );

    // Monday, after.
    const after = plan(
      request({
        now: new Date('2026-03-30T05:00:00.000Z'),
        rangeStart: new Date('2026-03-30T05:00:00.000Z'),
        rangeEnd: new Date('2026-03-31T00:00:00.000Z'),
        preferences: berlin,
        tasks: [task({ id: 't1', estimatedMinutes: 60 })],
      }),
    );

    // 09:00 in Berlin is 08:00 UTC in winter and 07:00 UTC in summer: the same local hour at a
    // different instant, which is the entire reason this is computed in the person's zone.
    expect(iso(before.blocks[0]?.startAt)).toBe('2026-03-27T08:00:00.000Z');
    expect(iso(after.blocks[0]?.startAt)).toBe('2026-03-30T07:00:00.000Z');
  });

  it('does not lose an hour of a working day to a DST change', () => {
    const result = plan(
      request({
        // The Sunday the clocks go forward, with Sunday as a working day.
        now: new Date('2026-03-29T00:00:00.000Z'),
        rangeStart: new Date('2026-03-29T00:00:00.000Z'),
        rangeEnd: new Date('2026-03-30T00:00:00.000Z'),
        preferences: {
          ...UTC_PREFERENCES,
          timeZone: 'Europe/Berlin',
          workDays: [7],
        },
        tasks: [task({ id: 't1', estimatedMinutes: 8 * 60 })],
      }),
    );

    // Nine to five local is still eight hours of wall clock time, even on a 23 hour day.
    expect(result.blocks).toHaveLength(1);
    expect(iso(result.blocks[0]?.startAt)).toBe('2026-03-29T07:00:00.000Z');
    expect(iso(result.blocks[0]?.endAt)).toBe('2026-03-29T15:00:00.000Z');
  });

  it('does not place work on a non-working day', () => {
    const result = plan(
      request({
        // Friday afternoon with a task too big for what is left of the week.
        now: new Date('2026-08-21T16:00:00.000Z'),
        rangeStart: new Date('2026-08-21T16:00:00.000Z'),
        rangeEnd: new Date('2026-08-25T00:00:00.000Z'),
        tasks: [task({ id: 't1', estimatedMinutes: 120 })],
      }),
    );

    // Monday morning, not Saturday.
    expect(iso(result.blocks[0]?.startAt)).toBe('2026-08-24T09:00:00.000Z');
  });
});

describe('plan: explanations', () => {
  it('gives every block a reason it was put there', () => {
    const result = plan(
      request({
        tasks: [
          task({
            id: 't1',
            priority: 'high',
            dueAt: new Date('2026-08-19T18:00:00.000Z'),
            estimatedMinutes: 60,
          }),
        ],
      }),
    );

    expect(result.blocks[0]?.reasons).toEqual(
      expect.arrayContaining([
        'due_within_24_hours',
        'high_priority',
        'earliest_available',
        'fits_available_window',
        'before_deadline',
      ]),
    );
  });

  it('names the task on everything it could not place', () => {
    const result = plan(
      request({
        tasks: [task({ id: 'huge', title: 'Rewrite everything', estimatedMinutes: 600 })],
      }),
    );

    expect(result.unscheduled[0]).toMatchObject({ taskId: 'huge', title: 'Rewrite everything' });
    expect(result.unscheduled[0]?.detail.length).toBeGreaterThan(0);
  });
});

describe('plan: invariants', () => {
  /** A small deterministic generator, so a failure here is reproducible. */
  function lcg(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  it('never overlaps a fixed block or another proposal, across many shapes of day', () => {
    const random = lcg(20260819);

    for (let run = 0; run < 200; run += 1) {
      const blocks: PlannerBlock[] = [];
      for (let i = 0; i < Math.floor(random() * 4); i += 1) {
        const startHour = 9 + Math.floor(random() * 7);
        const lengthHours = 1 + Math.floor(random() * 2);
        blocks.push(
          block(
            `b${String(i)}`,
            `2026-08-19T${String(startHour).padStart(2, '0')}:00:00.000Z`,
            `2026-08-19T${String(Math.min(startHour + lengthHours, 23)).padStart(2, '0')}:00:00.000Z`,
          ),
        );
      }

      const tasks: PlannerTask[] = [];
      for (let i = 0; i < 1 + Math.floor(random() * 5); i += 1) {
        tasks.push(
          task({
            id: `t${String(i)}`,
            estimatedMinutes: 30 * (1 + Math.floor(random() * 4)),
            ...(random() > 0.5 ? { dueAt: new Date('2026-08-19T17:00:00.000Z') } : {}),
          }),
        );
      }

      const result = plan(request({ blocks, tasks }));
      const proposed = result.blocks.map((b) => ({
        start: b.startAt.getTime(),
        end: b.endAt.getTime(),
      }));

      for (const p of proposed) {
        for (const fixed of blocks) {
          const clashes = p.start < fixed.endAt.getTime() && fixed.startAt.getTime() < p.end;
          expect(clashes, `run ${String(run)}: proposal overlaps a fixed block`).toBe(false);
        }
      }
      for (let i = 0; i < proposed.length; i += 1) {
        for (let j = i + 1; j < proposed.length; j += 1) {
          const a = proposed[i];
          const b = proposed[j];
          if (!a || !b) continue;
          expect(a.start < b.end && b.start < a.end, `run ${String(run)}: proposals overlap`).toBe(
            false,
          );
        }
      }
    }
  });

  it('never proposes work outside working hours or before now', () => {
    const random = lcg(7);
    for (let run = 0; run < 100; run += 1) {
      const tasks: PlannerTask[] = [];
      for (let i = 0; i < 1 + Math.floor(random() * 4); i += 1) {
        tasks.push(
          task({ id: `t${String(i)}`, estimatedMinutes: 30 * (1 + Math.floor(random() * 3)) }),
        );
      }
      const result = plan(request({ rangeEnd: new Date('2026-08-26T00:00:00.000Z'), tasks }));

      for (const proposal of result.blocks) {
        expect(proposal.startAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
        const startHour = proposal.startAt.getUTCHours();
        const endHour = proposal.endAt.getUTCHours() + (proposal.endAt.getUTCMinutes() > 0 ? 1 : 0);
        expect(startHour).toBeGreaterThanOrEqual(9);
        expect(endHour).toBeLessThanOrEqual(17);
        // Monday to Friday only.
        expect(proposal.startAt.getUTCDay()).toBeGreaterThanOrEqual(1);
        expect(proposal.startAt.getUTCDay()).toBeLessThanOrEqual(5);
      }
    }
  });
});
