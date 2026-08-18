/**
 * Provider abstraction. Everything above this file speaks in these types, so swapping or adding a
 * model vendor is a new implementation of `ScalarModelProvider` and nothing else.
 */

export interface ModelToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type ModelMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; text: string; toolCalls: ModelToolCall[] }
  | { role: 'tool'; results: ModelToolResult[] };

/** How hard the model should work. Maps onto provider specific controls. */
export type ModelEffort = 'low' | 'medium' | 'high';

export interface GenerateInput {
  system: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  maxTokens?: number;
  effort?: ModelEffort;
  signal?: AbortSignal;
}

export type GenerateStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';

export interface GenerateResult {
  text: string;
  toolCalls: ModelToolCall[];
  stopReason: GenerateStopReason;
  /** Present when the provider declined the request. */
  refusal?: { category: string | null; explanation: string | null };
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface StructuredOutputInput<T> {
  system: string;
  messages: ModelMessage[];
  /** JSON Schema describing the required response shape. */
  schema: Record<string, unknown>;
  /** Validates and narrows the parsed response. Throws to reject. */
  parse: (value: unknown) => T;
  maxTokens?: number;
  effort?: ModelEffort;
  signal?: AbortSignal;
}

export interface StructuredOutputResult<T> {
  value: T;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface EmbedInput {
  texts: string[];
  signal?: AbortSignal;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
}

/**
 * A model vendor. `embed` is optional: not every provider offers embeddings, and Scalar's
 * deterministic search does not depend on them.
 */
export interface ScalarModelProvider {
  readonly name: string;
  generate(input: GenerateInput): Promise<GenerateResult>;
  stream?(input: GenerateInput): AsyncIterable<string>;
  structuredOutput<T>(input: StructuredOutputInput<T>): Promise<StructuredOutputResult<T>>;
  embed?(input: EmbedInput): Promise<EmbedResult>;
}

/** Thrown when the provider is unreachable or misconfigured. Callers map this to a 503. */
export class ProviderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderUnavailableError';
  }
}

/** Thrown when the model returns something that does not match the requested schema. */
export class ModelOutputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelOutputError';
  }
}
