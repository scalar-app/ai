import { describe, expect, it, vi } from 'vitest';
import { runCommand } from '../src/command/loop.js';
import { ScriptedProvider, type ScriptedTurn } from '../src/providers/scripted.js';
import { createScalarTools, type ScalarToolExecutors } from '../src/tools/scalar-tools.js';
import { ToolRegistry, type ToolContext } from '../src/tools/registry.js';

const context: ToolContext = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  today: '2026-03-10',
  timeZone: 'America/New_York',
};

const TASK_ID = '33333333-3333-4333-8333-333333333333';

function task(overrides: Partial<{ id: string; title: string }> = {}) {
  return {
    id: overrides.id ?? TASK_ID,
    title: overrides.title ?? 'Finish problem set 4',
    status: 'todo',
    priority: 'high',
    dueAt: '2026-03-12T23:59:00-04:00',
    spaceName: 'Linear Algebra',
  };
}

function executors(overrides: Partial<ScalarToolExecutors> = {}): ScalarToolExecutors {
  return {
    searchTasks: vi.fn(() => Promise.resolve([task()])),
    listEvents: vi.fn(() => Promise.resolve([])),
    getToday: vi.fn(() =>
      Promise.resolve({
        date: '2026-03-10',
        greeting: 'Good morning',
        attentionCount: 1,
        overdue: [],
        dueToday: [task()],
        urgent: [],
        upcoming: [],
      }),
    ),
    listSpaces: vi.fn(() =>
      Promise.resolve([{ id: '44444444-4444-4444-8444-444444444444', name: 'Linear Algebra' }]),
    ),
    findFreeTime: vi.fn(() => Promise.resolve([])),
    createTask: vi.fn(() => Promise.resolve(task())),
    updateTask: vi.fn(() => Promise.resolve(task())),
    scheduleTask: vi.fn(() => Promise.resolve(task())),
    ...overrides,
  };
}

function setup(turns: ScriptedTurn[], overrides: Partial<ScalarToolExecutors> = {}) {
  const exec = executors(overrides);
  const registry = new ToolRegistry();
  for (const tool of createScalarTools(exec)) registry.add(tool);
  const provider = new ScriptedProvider(turns);
  return { exec, registry, provider };
}

function run(turns: ScriptedTurn[], overrides: Partial<ScalarToolExecutors> = {}) {
  const { exec, registry, provider } = setup(turns, overrides);
  return runCommand({
    provider,
    registry,
    context,
    messages: [{ role: 'user', content: 'hi' }],
  }).then((result) => ({
    result,
    exec,
    provider,
  }));
}

describe('runCommand', () => {
  it('answers a plain question without touching tools', async () => {
    const { result, exec } = await run([{ type: 'text', text: 'You have one thing due today.' }]);

    expect(result.stopReason).toBe('answered');
    expect(result.answer).toBe('You have one thing due today.');
    expect(result.proposals).toEqual([]);
    expect(exec.getToday).not.toHaveBeenCalled();
  });

  it('runs read tools automatically and feeds the result back', async () => {
    const { result, exec, provider } = await run([
      { type: 'tools', calls: [{ id: 'call_1', name: 'get_today', input: {} }] },
      { type: 'text', text: 'Problem set 4 is due today.' },
    ]);

    expect(exec.getToday).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe('answered');
    expect(result.executed).toHaveLength(1);
    expect(result.executed[0]).toMatchObject({
      name: 'get_today',
      classification: 'read',
      ok: true,
    });

    const lastRequest = provider.requests.at(-1);
    const toolMessage = lastRequest?.messages.at(-1);
    expect(toolMessage?.role).toBe('tool');
    if (toolMessage?.role === 'tool') {
      expect(toolMessage.results[0]?.content).toContain('Good morning');
    }
  });

  it('does not execute a write tool: it proposes it', async () => {
    const { result, exec } = await run([
      {
        type: 'tools',
        calls: [
          {
            id: 'call_1',
            name: 'create_task',
            input: { title: 'Email the TA', dueAt: '2026-03-11T17:00:00-04:00' },
          },
        ],
      },
      { type: 'text', text: 'I can add that task for you.' },
    ]);

    expect(exec.createTask).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('needs_approval');
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ tool: 'create_task', classification: 'write' });
    expect(result.proposals[0]?.summary).toContain('Email the TA');
    // A proposal is not an executed call, so the audit trail never claims it happened.
    expect(result.executed).toEqual([]);
  });

  it('tells the model the change is pending, not done', async () => {
    const { provider } = await run([
      {
        type: 'tools',
        calls: [{ id: 'call_1', name: 'create_task', input: { title: 'Email the TA' } }],
      },
      { type: 'text', text: 'Proposed.' },
    ]);

    const toolMessage = provider.requests.at(-1)?.messages.at(-1);
    expect(toolMessage?.role).toBe('tool');
    if (toolMessage?.role === 'tool') {
      expect(toolMessage.results[0]?.content).toContain('has not happened yet');
    }
  });

  it('rejects tool input that fails validation and lets the model retry', async () => {
    const { result, exec } = await run([
      { type: 'tools', calls: [{ id: 'call_1', name: 'create_task', input: { title: '' } }] },
      { type: 'text', text: 'I need a title for that task.' },
    ]);

    expect(exec.createTask).not.toHaveBeenCalled();
    expect(result.proposals).toEqual([]);
    expect(result.executed[0]).toMatchObject({ name: 'create_task', ok: false });
    expect(result.stopReason).toBe('answered');
  });

  it('rejects a schedule that ends before it starts', async () => {
    const { result } = await run([
      {
        type: 'tools',
        calls: [
          {
            id: 'call_1',
            name: 'schedule_task',
            input: {
              taskId: TASK_ID,
              scheduledStart: '2026-03-10T15:00:00-04:00',
              scheduledEnd: '2026-03-10T14:00:00-04:00',
            },
          },
        ],
      },
      { type: 'text', text: 'That window was backwards.' },
    ]);

    expect(result.proposals).toEqual([]);
    expect(result.executed[0]?.ok).toBe(false);
  });

  it('reports an unknown tool without failing the turn', async () => {
    const { result } = await run([
      { type: 'tools', calls: [{ id: 'call_1', name: 'delete_everything', input: {} }] },
      { type: 'text', text: 'I cannot do that.' },
    ]);

    expect(result.stopReason).toBe('answered');
    expect(result.executed).toEqual([]);
  });

  it('surfaces a tool failure to the model instead of throwing', async () => {
    const { result } = await run(
      [
        { type: 'tools', calls: [{ id: 'call_1', name: 'search_tasks', input: {} }] },
        { type: 'text', text: 'I could not reach your tasks just now.' },
      ],
      {
        searchTasks: vi.fn(() => Promise.reject(new Error('database unavailable'))),
      },
    );

    expect(result.stopReason).toBe('answered');
    expect(result.executed[0]).toMatchObject({ ok: false, error: 'database unavailable' });
  });

  it('stops on a refusal and reports no answer', async () => {
    const { result } = await run([{ type: 'refusal', category: 'cyber' }]);

    expect(result.stopReason).toBe('refused');
    expect(result.answer).toBe('');
    expect(result.refusal?.category).toBe('cyber');
  });

  it('stops after maxSteps rather than looping forever', async () => {
    const { registry, provider } = setup(
      Array.from({ length: 6 }, (): ScriptedTurn => ({
        type: 'tools',
        calls: [{ id: 'call_x', name: 'get_today', input: {} }],
      })),
    );

    const result = await runCommand({
      provider,
      registry,
      context,
      messages: [{ role: 'user', content: 'hi' }],
      maxSteps: 3,
    });

    expect(result.stopReason).toBe('max_steps');
    expect(provider.requests).toHaveLength(3);
  });

  it('accumulates usage across steps', async () => {
    const { result } = await run([
      { type: 'tools', calls: [{ id: 'call_1', name: 'list_spaces', input: {} }] },
      { type: 'text', text: 'You have one space.' },
    ]);

    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(10);
  });

  it('reports every executed call through onToolCall', async () => {
    const { registry, provider } = setup([
      { type: 'tools', calls: [{ id: 'call_1', name: 'list_spaces', input: {} }] },
      { type: 'text', text: 'Done.' },
    ]);
    const seen: string[] = [];

    await runCommand({
      provider,
      registry,
      context,
      messages: [{ role: 'user', content: 'hi' }],
      onToolCall: (call) => seen.push(call.name),
    });

    expect(seen).toEqual(['list_spaces']);
  });
});
