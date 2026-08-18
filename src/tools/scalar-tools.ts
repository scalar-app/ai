import { z } from 'zod';
import { defineTool, objectSchema, type ScalarTool, type ToolContext } from './registry.js';

/**
 * The Stage 1 tool surface. Definitions live here so the model's view of Scalar stays in one file;
 * the executors are supplied by the API, which owns the database and the permission checks.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const isoDateTime = z.iso.datetime({ offset: true });

/* Shapes the tools return. Kept small on purpose: the model gets what it needs to answer, not the
   whole row. Less context in means less to leak and fewer tokens spent. */

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  spaceName: string | null;
}

export interface EventSummary {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  location: string | null;
  calendar: string | null;
}

export interface TodaySummary {
  date: string;
  greeting: string;
  attentionCount: number;
  overdue: TaskSummary[];
  dueToday: TaskSummary[];
  urgent: TaskSummary[];
  upcoming: EventSummary[];
}

export interface SpaceSummary {
  id: string;
  name: string;
}

export interface FreeSlot {
  startsAt: string;
  endsAt: string;
  minutes: number;
}

export interface SearchTasksInput {
  query?: string | undefined;
  status?: string[] | undefined;
  dueBefore?: string | undefined;
  dueAfter?: string | undefined;
  limit: number;
}

export interface CreateTaskInput {
  title: string;
  dueAt?: string | undefined;
  priority?: string | undefined;
  spaceId?: string | undefined;
  estimatedMinutes?: number | undefined;
}

export interface UpdateTaskInput {
  taskId: string;
  title?: string | undefined;
  status?: string | undefined;
  priority?: string | undefined;
  dueAt?: string | null | undefined;
}

export interface FindFreeTimeInput {
  from: string;
  to: string;
  minutes: number;
  dayStartHour: number;
  dayEndHour: number;
}

/**
 * Supplied by the API, which owns the database and the permission checks. Every executor receives
 * input that has already been validated against the tool schema.
 */
export interface ScalarToolExecutors {
  searchTasks: (input: SearchTasksInput, context: ToolContext) => Promise<TaskSummary[]>;
  listEvents: (
    input: { from: string; to: string },
    context: ToolContext,
  ) => Promise<EventSummary[]>;
  getToday: (input: { date?: string | undefined }, context: ToolContext) => Promise<TodaySummary>;
  listSpaces: (input: Record<string, never>, context: ToolContext) => Promise<SpaceSummary[]>;
  findFreeTime: (input: FindFreeTimeInput, context: ToolContext) => Promise<FreeSlot[]>;
  createTask: (input: CreateTaskInput, context: ToolContext) => Promise<TaskSummary>;
  updateTask: (input: UpdateTaskInput, context: ToolContext) => Promise<TaskSummary>;
  scheduleTask: (
    input: { taskId: string; scheduledStart: string; scheduledEnd: string },
    context: ToolContext,
  ) => Promise<TaskSummary>;
}

const TASK_STATUSES = ['inbox', 'todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

function formatWhen(iso: string): string {
  return iso
    .replace('T', ' ')
    .replace(/:\d\d\.\d+Z$/, '')
    .replace(/Z$/, '')
    .slice(0, 16);
}

export function createScalarTools(executors: ScalarToolExecutors): ScalarTool<never>[] {
  const searchTasks = defineTool({
    name: 'search_tasks',
    description:
      'Search the tasks in the current workspace. Use it to answer questions about what is due, what is open, or to find a task before changing it. Returns at most `limit` tasks with their id, title, status, priority and due date.',
    classification: 'read',
    input: z.object({
      query: z.string().max(200).optional(),
      status: z.array(z.enum(TASK_STATUSES)).optional(),
      dueBefore: isoDateTime.optional(),
      dueAfter: isoDateTime.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    jsonSchema: objectSchema({
      query: { type: 'string', description: 'Case insensitive substring of the task title.' },
      status: {
        type: 'array',
        items: { type: 'string', enum: [...TASK_STATUSES] },
        description: 'Restrict to these statuses. Omit for all open and closed tasks.',
      },
      dueBefore: {
        type: 'string',
        description: 'ISO timestamp. Only tasks due at or before this.',
      },
      dueAfter: { type: 'string', description: 'ISO timestamp. Only tasks due at or after this.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum tasks to return. Default 20.',
      },
    }),
    execute: (input, context) => executors.searchTasks(input, context),
  });

  const listEvents = defineTool({
    name: 'list_events',
    description:
      'List calendar events that overlap a time range, from every connected calendar. Use it to answer questions about the schedule and to see what a day looks like before proposing time.',
    classification: 'read',
    input: z.object({ from: isoDateTime, to: isoDateTime }),
    jsonSchema: objectSchema(
      {
        from: { type: 'string', description: 'ISO timestamp for the start of the range.' },
        to: { type: 'string', description: 'ISO timestamp for the end of the range.' },
      },
      ['from', 'to'],
    ),
    execute: (input, context) => executors.listEvents(input, context),
  });

  const getToday = defineTool({
    name: 'get_today',
    description:
      "Get Scalar's computed view of one day: greeting, how many things need attention, overdue tasks, tasks due today, urgent tasks and the day's events. Prefer this over separate searches when the question is about today or a specific date.",
    classification: 'read',
    input: z.object({ date: isoDate.optional() }),
    jsonSchema: objectSchema({
      date: { type: 'string', description: 'YYYY-MM-DD in the user time zone. Defaults to today.' },
    }),
    execute: (input, context) => executors.getToday(input, context),
  });

  const listSpaces = defineTool({
    name: 'list_spaces',
    description:
      'List the spaces in the workspace (courses, projects, areas of life). Use it to resolve a space name to an id before creating a task in it.',
    classification: 'read',
    input: z.object({}),
    jsonSchema: objectSchema({}),
    execute: (input, context) => executors.listSpaces(input, context),
  });

  const findFreeTime = defineTool({
    name: 'find_free_time',
    description:
      'Find gaps in the calendar of at least `minutes` long inside a range, honoring working hours. This is ordinary calendar arithmetic computed by Scalar, not by you: use it instead of working out free time yourself.',
    classification: 'read',
    input: z.object({
      from: isoDateTime,
      to: isoDateTime,
      minutes: z.number().int().min(5).max(600),
      dayStartHour: z.number().int().min(0).max(23).default(9),
      dayEndHour: z.number().int().min(1).max(24).default(21),
    }),
    jsonSchema: objectSchema(
      {
        from: { type: 'string', description: 'ISO timestamp for the start of the search range.' },
        to: { type: 'string', description: 'ISO timestamp for the end of the search range.' },
        minutes: {
          type: 'integer',
          minimum: 5,
          maximum: 600,
          description: 'Minimum length of a usable gap.',
        },
        dayStartHour: {
          type: 'integer',
          minimum: 0,
          maximum: 23,
          description: 'Earliest local hour to suggest. Default 9.',
        },
        dayEndHour: {
          type: 'integer',
          minimum: 1,
          maximum: 24,
          description: 'Latest local hour to suggest. Default 21.',
        },
      },
      ['from', 'to', 'minutes'],
    ),
    execute: (input, context) => executors.findFreeTime(input, context),
  });

  const createTask = defineTool({
    name: 'create_task',
    description:
      'Create a task in the current workspace. Use it when the user asks for something to be captured or turned into a task.',
    classification: 'write',
    input: z.object({
      title: z.string().trim().min(1).max(500),
      dueAt: isoDateTime.optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      spaceId: z.uuid().optional(),
      estimatedMinutes: z.number().int().min(0).max(100_000).optional(),
    }),
    jsonSchema: objectSchema(
      {
        title: {
          type: 'string',
          description: 'What the task is, in the user own words where possible.',
        },
        dueAt: { type: 'string', description: 'ISO timestamp for the deadline.' },
        priority: { type: 'string', enum: [...TASK_PRIORITIES] },
        spaceId: {
          type: 'string',
          description: 'Id of the space this belongs to, from list_spaces.',
        },
        estimatedMinutes: {
          type: 'integer',
          minimum: 0,
          description: 'How long the work should take.',
        },
      },
      ['title'],
    ),
    describeAction: (input) =>
      `Create task "${input.title}"${input.dueAt ? ` due ${formatWhen(input.dueAt)}` : ''}`,
    execute: (input, context) => executors.createTask(input, context),
  });

  const updateTask = defineTool({
    name: 'update_task',
    description:
      'Change an existing task: its title, status, priority or due date. Find the task with search_tasks first so you are changing the right one.',
    classification: 'write',
    input: z
      .object({
        taskId: z.uuid(),
        title: z.string().trim().min(1).max(500).optional(),
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        dueAt: isoDateTime.nullable().optional(),
      })
      .refine((value) => Object.keys(value).length > 1, {
        message: 'Provide at least one field to change.',
      }),
    jsonSchema: objectSchema(
      {
        taskId: { type: 'string', description: 'Id of the task, from search_tasks.' },
        title: { type: 'string' },
        status: { type: 'string', enum: [...TASK_STATUSES] },
        priority: { type: 'string', enum: [...TASK_PRIORITIES] },
        dueAt: {
          type: ['string', 'null'],
          description: 'ISO timestamp, or null to clear the deadline.',
        },
      },
      ['taskId'],
    ),
    describeAction: (input) => {
      const changes: string[] = [];
      if (input.title) changes.push(`title to "${input.title}"`);
      if (input.status) changes.push(`status to ${input.status}`);
      if (input.priority) changes.push(`priority to ${input.priority}`);
      if (input.dueAt === null) changes.push('remove the deadline');
      else if (input.dueAt) changes.push(`due date to ${formatWhen(input.dueAt)}`);
      return `Update task: change ${changes.join(', ')}`;
    },
    execute: (input, context) => executors.updateTask(input, context),
  });

  const scheduleTask = defineTool({
    name: 'schedule_task',
    description:
      'Block time on the calendar for a task by setting its scheduled start and end. Use find_free_time first; propose a slot rather than inventing one.',
    classification: 'write',
    input: z
      .object({ taskId: z.uuid(), scheduledStart: isoDateTime, scheduledEnd: isoDateTime })
      .refine((value) => new Date(value.scheduledStart) < new Date(value.scheduledEnd), {
        message: 'scheduledEnd must be after scheduledStart.',
      }),
    jsonSchema: objectSchema(
      {
        taskId: { type: 'string', description: 'Id of the task, from search_tasks.' },
        scheduledStart: { type: 'string', description: 'ISO timestamp when the work starts.' },
        scheduledEnd: { type: 'string', description: 'ISO timestamp when the work ends.' },
      },
      ['taskId', 'scheduledStart', 'scheduledEnd'],
    ),
    describeAction: (input) =>
      `Schedule work from ${formatWhen(input.scheduledStart)} to ${formatWhen(input.scheduledEnd)}`,
    execute: (input, context) => executors.scheduleTask(input, context),
  });

  return [
    searchTasks,
    listEvents,
    getToday,
    listSpaces,
    findFreeTime,
    createTask,
    updateTask,
    scheduleTask,
  ] as unknown as ScalarTool<never>[];
}
