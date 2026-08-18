export {
  ModelOutputError,
  ProviderUnavailableError,
  type EmbedInput,
  type EmbedResult,
  type GenerateInput,
  type GenerateResult,
  type GenerateStopReason,
  type ModelEffort,
  type ModelMessage,
  type ModelToolCall,
  type ModelToolDefinition,
  type ModelToolResult,
  type ScalarModelProvider,
  type StructuredOutputInput,
  type StructuredOutputResult,
} from './provider.js';

export {
  AnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
  toAnthropicMessages,
  type AnthropicProviderOptions,
} from './providers/anthropic.js';
export { ScriptedProvider, type ScriptedTurn } from './providers/scripted.js';

export {
  ToolRegistry,
  defineTool,
  objectSchema,
  type AnyScalarTool,
  type DefineToolOptions,
  type ScalarTool,
  type ToolClassification,
  type ToolContext,
  type ToolExecutor,
} from './tools/registry.js';

export {
  createScalarTools,
  type EventSummary,
  type FreeSlot,
  type ScalarToolExecutors,
  type SpaceSummary,
  type TaskSummary,
  type TodaySummary,
} from './tools/scalar-tools.js';

export { buildSystemPrompt, wrapExternalContent } from './prompt.js';

export {
  runCommand,
  type CommandResult,
  type ExecutedToolCall,
  type ProposedAction,
  type RunCommandOptions,
} from './command/loop.js';

export {
  findFreeSlots,
  type BusyInterval,
  type FindFreeSlotsInput,
  type FreeSlot as FreeTimeSlot,
} from './scheduling.js';
