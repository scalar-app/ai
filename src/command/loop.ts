import { buildSystemPrompt } from '../prompt.js';
import type {
  ModelEffort,
  ModelMessage,
  ModelToolResult,
  ScalarModelProvider,
} from '../provider.js';
import type { ToolClassification, ToolContext, ToolRegistry } from '../tools/registry.js';

/** A tool call the model made and Scalar ran, recorded for the audit trail. */
export interface ExecutedToolCall {
  id: string;
  name: string;
  classification: ToolClassification;
  input: unknown;
  ok: boolean;
  error?: string;
}

/** A change the model wants to make. Nothing has happened yet. */
export interface ProposedAction {
  id: string;
  tool: string;
  classification: Exclude<ToolClassification, 'read'>;
  /** Plain language sentence describing what approving this does. */
  summary: string;
  /** Validated input, safe to execute as-is once approved. */
  input: unknown;
}

export interface CommandResult {
  answer: string;
  proposals: ProposedAction[];
  executed: ExecutedToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  stopReason: 'answered' | 'needs_approval' | 'refused' | 'max_steps' | 'max_tokens';
  /** Present when the provider declined the request. */
  refusal?: { category: string | null; explanation: string | null };
}

export interface RunCommandOptions {
  provider: ScalarModelProvider;
  registry: ToolRegistry;
  context: ToolContext;
  /** The conversation so far, oldest first. The last entry must be the user's message. */
  messages: ModelMessage[];
  /** Cap on model turns, so a confused loop ends rather than running forever. */
  maxSteps?: number;
  maxTokens?: number;
  effort?: ModelEffort;
  signal?: AbortSignal;
  /** Called after each executed tool, for logging and audit. */
  onToolCall?: (call: ExecutedToolCall) => void;
}

const DEFAULT_MAX_STEPS = 6;
const MAX_TOOL_RESULT_CHARS = 8000;

function serializeResult(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  return json.length > MAX_TOOL_RESULT_CHARS
    ? `${json.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)`
    : json;
}

function proposalId(callId: string): string {
  return `prop_${callId}`;
}

/**
 * Runs one Command turn.
 *
 * Read tools execute immediately. Suggest and write tools never execute here: they are validated,
 * turned into proposals, and reported back to the model as pending so it can explain what it is
 * asking for. The API executes an approved proposal later, re-checking permissions at that point.
 *
 * The model never sees the database and never decides whether it may act.
 */
export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const { provider, registry, context } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const system = buildSystemPrompt(context);
  const tools = registry.definitions();

  const messages: ModelMessage[] = [...options.messages];
  const executed: ExecutedToolCall[] = [];
  const proposals: ProposedAction[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let model = provider.name;

  for (let step = 0; step < maxSteps; step += 1) {
    const result = await provider.generate({
      system,
      messages,
      tools,
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    model = result.model;

    if (result.stopReason === 'refusal') {
      return {
        answer: '',
        proposals,
        executed,
        usage,
        model,
        stopReason: 'refused',
        ...(result.refusal ? { refusal: result.refusal } : {}),
      };
    }

    if (result.toolCalls.length === 0) {
      return {
        answer: result.text,
        proposals,
        executed,
        usage,
        model,
        stopReason:
          result.stopReason === 'max_tokens'
            ? 'max_tokens'
            : proposals.length > 0
              ? 'needs_approval'
              : 'answered',
      };
    }

    messages.push({ role: 'assistant', text: result.text, toolCalls: result.toolCalls });

    const results: ModelToolResult[] = [];
    for (const call of result.toolCalls) {
      const tool = registry.get(call.name);
      if (!tool) {
        results.push({ toolCallId: call.id, content: `Unknown tool: ${call.name}`, isError: true });
        continue;
      }

      const parsed = tool.input.safeParse(call.input);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; ');
        const record: ExecutedToolCall = {
          id: call.id,
          name: call.name,
          classification: tool.classification,
          input: call.input,
          ok: false,
          error: message,
        };
        executed.push(record);
        options.onToolCall?.(record);
        results.push({ toolCallId: call.id, content: `Invalid input. ${message}`, isError: true });
        continue;
      }

      if (tool.classification !== 'read') {
        const proposal: ProposedAction = {
          id: proposalId(call.id),
          tool: tool.name,
          classification: tool.classification,
          summary: tool.describeAction?.(parsed.data) ?? `Run ${tool.name}`,
          input: parsed.data,
        };
        proposals.push(proposal);
        results.push({
          toolCallId: call.id,
          content: `Proposed to the user and awaiting their approval: ${proposal.summary}. It has not happened yet. Tell the user what you are proposing; do not call this tool again.`,
        });
        continue;
      }

      try {
        const output = await tool.execute(parsed.data, context);
        const record: ExecutedToolCall = {
          id: call.id,
          name: call.name,
          classification: tool.classification,
          input: parsed.data,
          ok: true,
        };
        executed.push(record);
        options.onToolCall?.(record);
        results.push({ toolCallId: call.id, content: serializeResult(output) });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Tool failed.';
        const record: ExecutedToolCall = {
          id: call.id,
          name: call.name,
          classification: tool.classification,
          input: parsed.data,
          ok: false,
          error: message,
        };
        executed.push(record);
        options.onToolCall?.(record);
        results.push({ toolCallId: call.id, content: `Tool failed: ${message}`, isError: true });
      }
    }

    messages.push({ role: 'tool', results });
  }

  return {
    answer: '',
    proposals,
    executed,
    usage,
    model,
    stopReason: 'max_steps',
  };
}
