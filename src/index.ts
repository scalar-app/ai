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
  OpenAICompatibleProvider,
  toChatMessages,
  type OpenAICompatibleProviderOptions,
} from './providers/openai-compatible.js';
export {
  AI_PROVIDERS,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  ProviderConfigurationError,
  createModelProvider,
  isAiProviderName,
  type AiProviderName,
  type ModelProviderConfig,
} from './providers/factory.js';

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

export { plan } from './planner/plan.js';
export {
  availableWindows,
  overlappingBlocks,
  workingWindows,
  type AvailableWindow,
} from './planner/availability.js';
export type {
  ConflictKind,
  PlanReason,
  PlannerBlock,
  PlannerPreferences,
  PlannerPriority,
  PlannerTask,
  PlanningConflict,
  PlanningRequest,
  PlanningResult,
  PlanningWarning,
  PreferredWindow,
  ProposedBlock,
  UnscheduledItem,
  WarningKind,
} from './planner/types.js';

export {
  isValidTimeZone,
  localDateKey,
  localMidnight,
  localTimeOnDay,
  localTimeOnDayMinutes,
  localWeekday,
} from './time.js';

export {
  findFreeSlots,
  type BusyInterval,
  type FindFreeSlotsInput,
  type FreeSlot as FreeTimeSlot,
} from './scheduling.js';
